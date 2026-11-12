/**
 * Admin API for the VPN commerce sections (overview, customers, coupons,
 * tickets, audit). Every handler requires an authenticated admin session and
 * every state change additionally requires the CSRF header — hiding a button
 * is not authorization, so the checks live here, server-side.
 *
 * Sensitive actions (blocking customers, coupon create/toggle, ticket replies
 * and status changes) are appended to the admin_audit_log.
 */
import type { Env } from '../env';
import { json } from './api';
import { timingSafeEqual } from '../auth';
import { getSession, type AdminSession } from '../db';
import {
  createCoupon,
  listCoupons,
  setCouponActive,
  type NewCouponInput,
} from '../vpn/coupons';
import {
  addTicketMessage,
  listTicketMessages,
  listTickets,
  setTicketStatus,
  getTicket,
} from '../support/tickets';
import { listCustomers, setCustomerBlocked } from '../customer/repo';
import { SESSION_COOKIE } from '../auth';

function cookieToken(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function requireAdmin(request: Request, env: Env): Promise<AdminSession | null> {
  const token = cookieToken(request);
  if (!token) return null;
  return getSession(env.DB, token);
}

async function requireAdminCsrf(request: Request, env: Env): Promise<AdminSession | null> {
  const session = await requireAdmin(request, env);
  if (!session) return null;
  const csrf = request.headers.get('X-CSRF-Token') ?? '';
  if (!csrf || !timingSafeEqual(csrf, session.csrf_token)) return null;
  return session;
}

export async function writeAuditLog(
  db: D1Database,
  action: string,
  target: string | null,
  detail: string | null,
  ip: string | null,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (actor, action, target, detail, ip, created_at)
       VALUES ('admin', ?, ?, ?, ?, ?)`,
    )
    .bind(action, target, detail, ip, nowIso)
    .run();
}

/* ---------- overview ---------- */

export async function adminVpnOverview(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM vpn_customers) AS customers_total,
       (SELECT COUNT(*) FROM vpn_customers WHERE created_at >= ?1) AS customers_new_week,
       (SELECT COUNT(*) FROM vpn_orders) AS orders_total,
       (SELECT COUNT(*) FROM vpn_orders WHERE created_at >= ?2) AS orders_today,
       (SELECT COUNT(*) FROM vpn_orders WHERE created_at >= ?3) AS orders_month,
       (SELECT COALESCE(SUM(amount_cents),0) FROM vpn_orders WHERE payment_status = 'paid') AS gross_cents,
       (SELECT COALESCE(SUM(discount_cents),0) FROM vpn_orders WHERE payment_status = 'paid') AS discounts_cents,
       (SELECT COALESCE(SUM(amount_cents),0) FROM vpn_orders WHERE payment_status = 'refunded') AS refunds_cents,
       (SELECT COUNT(*) FROM vpn_orders WHERE order_status = 'active') AS services_active,
       (SELECT COUNT(*) FROM vpn_orders WHERE order_status = 'expired') AS services_expired,
       (SELECT COUNT(*) FROM vpn_orders WHERE provisioning_status IN ('claimed','provisioning')) AS provisioning_pending,
       (SELECT COUNT(*) FROM vpn_orders WHERE order_status = 'provisioning_failed') AS provisioning_failed,
       (SELECT COUNT(*) FROM support_tickets WHERE status = 'open') AS tickets_open`,
  )
    .bind(weekAgo, todayStart, monthStart)
    .first<Record<string, number>>();

  const recentOrders = await env.DB.prepare(
    `SELECT id, customer_email, plan_id, amount_cents, currency, order_status, payment_status,
            provisioning_status, payment_provider, created_at
       FROM vpn_orders ORDER BY created_at DESC LIMIT 8`,
  ).all();

  const recentAudit = await env.DB.prepare(
    `SELECT action, target, detail, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 8`,
  ).all();

  return json({
    stats: stats ?? {},
    netRevenueCents:
      (stats?.gross_cents ?? 0) - (stats?.discounts_cents ?? 0) - (stats?.refunds_cents ?? 0),
    recentOrders: recentOrders.results ?? [],
    recentAudit: recentAudit.results ?? [],
  });
}

/* ---------- customers ---------- */

export async function adminVpnCustomers(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').slice(0, 100);
  const customers = await listCustomers(env.DB, q, 100);
  return json({
    customers: customers.map((c) => ({
      id: c.id,
      email: c.email_norm,
      createdAt: c.created_at,
      orderCount: c.order_count,
      paidCount: c.paid_count,
      blockedAt: c.blocked_at,
      blockedReason: c.blocked_reason,
    })),
  });
}

export async function adminVpnCustomerBlock(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const session = await requireAdminCsrf(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 403);

  let body: { blocked?: unknown; reason?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* treated as empty */
  }
  const blocked = body.blocked === true;
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null;
  if (blocked && !reason) return json({ error: 'A reason is required when blocking a customer.' }, 422);

  const nowIso = new Date().toISOString();
  const ok = await setCustomerBlocked(env.DB, id, blocked, reason, nowIso);
  if (!ok) return json({ error: 'Customer not found.' }, 404);
  await writeAuditLog(
    env.DB,
    blocked ? 'customer_blocked' : 'customer_unblocked',
    id,
    reason,
    request.headers.get('CF-Connecting-IP'),
    nowIso,
  );
  return json({ ok: true, blocked });
}

/* ---------- coupons ---------- */

export async function adminVpnCoupons(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);
  return json({ coupons: await listCoupons(env.DB) });
}

export async function adminVpnCouponCreate(request: Request, env: Env): Promise<Response> {
  const session = await requireAdminCsrf(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code : '';
  const discountType = body.discountType === 'percent' ? 'percent' : body.discountType === 'fixed' ? 'fixed' : null;
  const discountValue = typeof body.discountValue === 'number' ? Math.round(body.discountValue) : NaN;
  if (!code || !discountType || !Number.isFinite(discountValue)) {
    return json({ error: 'code, discountType (fixed|percent) and discountValue are required.' }, 422);
  }
  const appliesPlanId =
    body.appliesPlanId === 'monthly' || body.appliesPlanId === 'annual' || body.appliesPlanId === 'two-year'
      ? body.appliesPlanId
      : null;
  const asIsoOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.length >= 10 ? new Date(v).toISOString() : null;

  try {
    const input: NewCouponInput = {
      code,
      description: typeof body.description === 'string' ? body.description.slice(0, 300) : null,
      discountType,
      discountValue,
      appliesPlanId,
      firstPurchaseOnly: body.firstPurchaseOnly === true,
      startsAt: asIsoOrNull(body.startsAt),
      expiresAt: asIsoOrNull(body.expiresAt),
      maxRedemptions: typeof body.maxRedemptions === 'number' && body.maxRedemptions > 0 ? Math.round(body.maxRedemptions) : null,
      perCustomerLimit: typeof body.perCustomerLimit === 'number' && body.perCustomerLimit > 0 ? Math.round(body.perCustomerLimit) : 1,
    };
    const coupon = await createCoupon(env.DB, input, new Date().toISOString());
    await writeAuditLog(
      env.DB,
      'coupon_created',
      coupon.code,
      `${coupon.discount_type} ${coupon.discount_value}${coupon.discount_type === 'percent' ? '%' : ' cents'}`,
      request.headers.get('CF-Connecting-IP'),
      new Date().toISOString(),
    );
    return json({ ok: true, coupon }, 201);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not create coupon.' }, 422);
  }
}

export async function adminVpnCouponToggle(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireAdminCsrf(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 403);

  let body: { active?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* treated as empty */
  }
  if (typeof body.active !== 'boolean') return json({ error: 'active (boolean) is required.' }, 422);
  const nowIso = new Date().toISOString();
  const ok = await setCouponActive(env.DB, id, body.active);
  if (!ok) return json({ error: 'Coupon not found.' }, 404);
  await writeAuditLog(env.DB, body.active ? 'coupon_activated' : 'coupon_deactivated', id, null, request.headers.get('CF-Connecting-IP'), nowIso);
  return json({ ok: true, active: body.active });
}

/* ---------- support tickets ---------- */

export async function adminVpnTickets(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const tickets = await listTickets(env.DB, status && ['open', 'pending', 'closed'].includes(status) ? status : null);
  return json({ tickets });
}

export async function adminVpnTicketDetail(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);
  const ticket = await getTicket(env.DB, id);
  if (!ticket) return json({ error: 'Ticket not found.' }, 404);
  return json({ ticket, messages: await listTicketMessages(env.DB, id) });
}

export async function adminVpnTicketReply(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireAdminCsrf(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 403);
  const ticket = await getTicket(env.DB, id);
  if (!ticket) return json({ error: 'Ticket not found.' }, 404);

  let body: { body?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* treated as empty */
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text || text.length > 5000) return json({ error: 'A reply body (max 5000 chars) is required.' }, 422);

  const nowIso = new Date().toISOString();
  await addTicketMessage(env.DB, id, 'admin', text, nowIso);
  await setTicketStatus(env.DB, id, 'pending', nowIso); // waiting on the customer
  await writeAuditLog(env.DB, 'ticket_reply', id, null, request.headers.get('CF-Connecting-IP'), nowIso);
  return json({ ok: true });
}

export async function adminVpnTicketStatus(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireAdminCsrf(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 403);
  const ticket = await getTicket(env.DB, id);
  if (!ticket) return json({ error: 'Ticket not found.' }, 404);

  let body: { status?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* treated as empty */
  }
  if (body.status !== 'open' && body.status !== 'pending' && body.status !== 'closed') {
    return json({ error: 'Invalid ticket status.' }, 422);
  }
  const nowIso = new Date().toISOString();
  await setTicketStatus(env.DB, id, body.status, nowIso);
  await writeAuditLog(env.DB, 'ticket_status', id, body.status, request.headers.get('CF-Connecting-IP'), nowIso);
  return json({ ok: true, status: body.status });
}

/* ---------- audit log ---------- */

export async function adminVpnAudit(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);
  const result = await env.DB.prepare(
    `SELECT id, actor, action, target, detail, ip, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 100`,
  ).all();
  return json({ entries: result.results ?? [] });
}
