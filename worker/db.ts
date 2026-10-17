/**
 * D1 access layer for advertising orders, sessions, rate limits and webhook
 * idempotency. Schema lives in migrations/0001_ads_init.sql.
 */
import type { Placement, Duration } from '../src/lib/ads/pricing';
import type { CreativeStatus } from './images';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type CampaignStatus = 'pending' | 'scheduled' | 'active' | 'completed' | 'cancelled';

export const PAYMENT_STATUSES: readonly PaymentStatus[] = ['pending', 'paid', 'failed', 'expired', 'cancelled'];
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected'];
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['pending', 'scheduled', 'active', 'completed', 'cancelled'];

export interface AdsOrder {
  id: string;
  customer_name: string;
  customer_email: string;
  customer_website: string;
  placement: Placement;
  duration_months: Duration;
  creative_format: 'text' | 'image';
  ad_copy: string | null;
  destination_url: string | null;
  creative_r2_key: string | null;
  amount_cents: number;
  currency: string;
  payment_status: PaymentStatus;
  stripe_checkout_session_id: string | null;
  stripe_payment_reference: string | null;
  approval_status: ApprovalStatus;
  campaign_status: CampaignStatus;
  campaign_start: string | null;
  campaign_end: string | null;
  admin_notes: string | null;
  customer_email_status: string | null;
  admin_email_status: string | null;
  creative_status: CreativeStatus;
  creative_width: number | null;
  creative_height: number | null;
  creative_optimization_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewOrder {
  id: string;
  customer_name: string;
  customer_email: string;
  customer_website: string;
  placement: Placement;
  duration_months: Duration;
  creative_format: 'text' | 'image';
  ad_copy: string | null;
  destination_url: string | null;
  creative_r2_key: string | null;
  amount_cents: number;
  currency: string;
  creative_status?: CreativeStatus;
  creative_width?: number | null;
  creative_height?: number | null;
  creative_optimization_error?: string | null;
}

export async function insertOrder(db: D1Database, order: NewOrder): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ads_orders (
         id, customer_name, customer_email, customer_website, placement, duration_months,
         creative_format, ad_copy, destination_url, creative_r2_key, amount_cents, currency,
         payment_status, approval_status, campaign_status, created_at, updated_at,
         creative_status, creative_width, creative_height, creative_optimization_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      order.id,
      order.customer_name,
      order.customer_email,
      order.customer_website,
      order.placement,
      order.duration_months,
      order.creative_format,
      order.ad_copy,
      order.destination_url,
      order.creative_r2_key,
      order.amount_cents,
      order.currency,
      now,
      now,
      order.creative_status ?? 'pending',
      order.creative_width ?? null,
      order.creative_height ?? null,
      order.creative_optimization_error ?? null,
    )
    .run();
}

export async function getOrder(db: D1Database, id: string): Promise<AdsOrder | null> {
  const row = await db.prepare('SELECT * FROM ads_orders WHERE id = ?').bind(id).first<AdsOrder>();
  return row ?? null;
}

/** Updates the creative state for an order (used by the admin replace path). */
export async function setCreativeState(
  db: D1Database,
  id: string,
  fields: {
    creative_r2_key: string;
    creative_status: CreativeStatus;
    creative_width: number;
    creative_height: number;
    creative_optimization_error: null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE ads_orders SET
         creative_r2_key = ?, creative_status = ?, creative_width = ?,
         creative_height = ?, creative_optimization_error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      fields.creative_r2_key,
      fields.creative_status,
      fields.creative_width,
      fields.creative_height,
      fields.creative_optimization_error,
      now,
      id,
    )
    .run();
}

export async function touchOrder(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE ads_orders SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
}

export async function setStripeSession(
  db: D1Database,
  id: string,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare('UPDATE ads_orders SET stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?')
    .bind(sessionId, now, id)
    .run();
}

/**
 * Marks an order paid. Called ONLY from the verified Stripe webhook path.
 * Payment and approval stay separate fields: paying never approves the ad.
 */
export async function markPaid(
  db: D1Database,
  id: string,
  paymentReference: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE ads_orders
         SET payment_status = 'paid', stripe_payment_reference = ?, updated_at = ?
       WHERE id = ? AND payment_status != 'paid'`,
    )
    .bind(paymentReference, now, id)
    .run();
  return res.meta.changes > 0;
}

export async function setPaymentStatus(
  db: D1Database,
  id: string,
  status: PaymentStatus,
  reference: string | null = null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE ads_orders SET payment_status = ?, stripe_payment_reference = COALESCE(?, stripe_payment_reference), updated_at = ?
       WHERE id = ?`,
    )
    .bind(status, reference, now, id)
    .run();
  return res.meta.changes > 0;
}

/**
 * Transitions a pending order to a non-paid terminal state (failed/expired).
 * A verified payment is never overwritten by a later negative event.
 */
export async function markNotPaidIfPending(
  db: D1Database,
  id: string,
  status: 'failed' | 'expired' | 'cancelled',
  reference: string | null = null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE ads_orders SET payment_status = ?, stripe_payment_reference = COALESCE(?, stripe_payment_reference), updated_at = ?
       WHERE id = ? AND payment_status = 'pending'`,
    )
    .bind(status, reference, now, id)
    .run();
  return res.meta.changes > 0;
}

export async function setEmailStatuses(
  db: D1Database,
  id: string,
  customer: string,
  admin: string,
): Promise<void> {
  await db
    .prepare('UPDATE ads_orders SET customer_email_status = ?, admin_email_status = ?, updated_at = ? WHERE id = ?')
    .bind(customer, admin, new Date().toISOString(), id)
    .run();
}

export interface ListParams {
  q?: string;
  payment?: PaymentStatus;
  approval?: ApprovalStatus;
  campaign?: CampaignStatus;
  page: number;
  perPage: number;
}

export interface ListResult {
  orders: AdsOrder[];
  total: number;
  page: number;
  perPage: number;
}

export async function listOrders(db: D1Database, params: ListParams): Promise<ListResult> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (params.q) {
    where.push('(id LIKE ? OR customer_name LIKE ? OR customer_email LIKE ? OR customer_website LIKE ?)');
    const like = `%${params.q}%`;
    binds.push(like, like, like, like);
  }
  if (params.payment) {
    where.push('payment_status = ?');
    binds.push(params.payment);
  }
  if (params.approval) {
    where.push('approval_status = ?');
    binds.push(params.approval);
  }
  if (params.campaign) {
    where.push('campaign_status = ?');
    binds.push(params.campaign);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = Math.max(0, (params.page - 1) * params.perPage);

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM ads_orders ${whereSql}`)
    .bind(...binds)
    .first<{ c: number }>();
  const total = totalRow?.c ?? 0;

  const orders = await db
    .prepare(`SELECT * FROM ads_orders ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, params.perPage, offset)
    .all<AdsOrder>();

  return { orders: orders.results ?? [], total, page: params.page, perPage: params.perPage };
}

/* ---------- Webhook idempotency ---------- */
export async function isWebhookEventProcessed(db: D1Database, eventId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT event_id FROM ads_webhook_events WHERE event_id = ?')
    .bind(eventId)
    .first<{ event_id: string }>();
  return !!row;
}

export async function recordWebhookEvent(
  db: D1Database,
  eventId: string,
  orderId: string | null,
  eventType: string,
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO ads_webhook_events (event_id, order_id, event_type, processed_at) VALUES (?, ?, ?, ?)')
    .bind(eventId, orderId, eventType, new Date().toISOString())
    .run();
}

/* ---------- Admin sessions ---------- */
export interface AdminSession {
  token: string;
  csrf_token: string;
  ip: string | null;
  created_at: string;
  expires_at: string;
}

export async function createSession(
  db: D1Database,
  token: string,
  csrfToken: string,
  ip: string | null,
  ttlSeconds: number,
): Promise<void> {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  await db
    .prepare('INSERT INTO ads_admin_sessions (token, csrf_token, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(token, csrfToken, ip, now.toISOString(), expires.toISOString())
    .run();
}

export async function getSession(db: D1Database, token: string): Promise<AdminSession | null> {
  const row = await db
    .prepare('SELECT * FROM ads_admin_sessions WHERE token = ?')
    .bind(token)
    .first<AdminSession>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare('DELETE FROM ads_admin_sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM ads_admin_sessions WHERE token = ?').bind(token).run();
}

/* ---------- Rate limiting (fixed window, D1-backed) ---------- */
export interface RateLimitResult {
  count: number;
  allowed: boolean;
}

/**
 * Increments the counter for (key, window) and reports whether the caller is
 * still under `limit` for the current window.
 */
export async function bumpRateLimit(
  db: D1Database,
  key: string,
  windowSeconds: number,
  limit: number,
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = nowSec - (nowSec % windowSeconds);
  const res = await db
    .prepare(
      `INSERT INTO ads_rate_limits (key, bucket, count, window_start) VALUES (?, ?, 1, ?)
         ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, bucket, bucket)
    .first<{ count: number }>();
  const count = res?.count ?? 1;
  return { count, allowed: count <= limit };
}

export async function clearRateLimit(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM ads_rate_limits WHERE key = ?').bind(key).run();
}
