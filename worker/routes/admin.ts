/**
 * Admin routes (all protected server-side):
 *   GET  /admin, /admin/                 dashboard shell (no sensitive data)
 *   GET  /admin/api/session              { authenticated, csrf }
 *   POST /admin/api/login                password -> session cookie
 *   POST /admin/api/logout
 *   GET  /admin/api/orders               list (search/filter/pagination)
 *   GET  /admin/api/orders/:id           detail
 *   GET  /admin/api/orders/:id/creative  safe preview (text or image)
 *   POST /admin/api/orders/:id/approval  { status: approved|rejected }
 *   POST /admin/api/orders/:id/campaign  { status, start? }
 *   POST /admin/api/orders/:id/note      { note }
 *
 * There is deliberately NO endpoint that sets payment_status: payment state
 * only ever changes through the signature-verified Stripe webhook.
 */
import type { Env } from '../env';
import {
  CAMPAIGN_STATUSES,
  clearRateLimit,
  bumpRateLimit,
  createSession,
  deleteSession,
  getSession,
  listOrders,
  getOrder,
  type AdminSession,
  type AdsOrder,
  type ApprovalStatus,
  type CampaignStatus,
} from '../db';
import {
  SESSION_COOKIE,
  clearSessionCookieHeader,
  newSessionToken,
  sessionCookieHeader,
  timingSafeEqual,
  verifyPassword,
} from '../auth';
import { campaignEnd } from '../../src/lib/ads/pricing';
import { optimizeCreative } from '../images';
import { validateImageFile, isAnimatedImage } from '../validation';
import { setCreativeState } from '../db';
import { adminShell } from '../render';

const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_ATTEMPTS = 10;
const PER_PAGE = 20;
const MAX_NOTE_LENGTH = 2000;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function currentSession(request: Request, env: Env): Promise<AdminSession | null> {
  const token = cookieToken(request);
  if (!token) return null;
  return getSession(env.DB, token);
}

/** Reads JSON bodies for admin actions. */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/* ---------- pages ---------- */
export async function adminPage(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  return html(adminShell(!!session));
}

/* ---------- auth ---------- */
export async function adminLogin(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD_HASH) return json({ error: 'Admin access is not configured.' }, 503);

  const body = await readJson(request);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) return json({ error: 'Password is required.' }, 400);

  const ip = clientIp(request);
  const rate = await bumpLoginRateLimit(env, ip);
  if (!rate.allowed) {
    return json({ error: 'Too many login attempts. Please try again in a few minutes.' }, 429);
  }

  const ok = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!ok) return json({ error: 'Invalid credentials.' }, 401);

  await clearRateLimit(env.DB, `login:${ip}`);

  const token = newSessionToken();
  const csrf = newSessionToken();
  await createSession(env.DB, token, csrf, ip, 12 * 60 * 60);
  return json({ ok: true, csrfToken: csrf }, 200, { 'Set-Cookie': sessionCookieHeader(token) });
}

async function bumpLoginRateLimit(env: Env, ip: string) {
  return bumpRateLimit(env.DB, `login:${ip}`, LOGIN_WINDOW_SECONDS, LOGIN_MAX_ATTEMPTS);
}

export async function adminLogout(request: Request, env: Env): Promise<Response> {
  const token = cookieToken(request);
  if (token) await deleteSession(env.DB, token);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
}

export async function adminSessionInfo(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ authenticated: false });
  return json({ authenticated: true, csrfToken: session.csrf_token });
}

/* ---------- data ---------- */
export async function adminListOrders(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const page = clampInt(url.searchParams.get('page'), 1, 1, 500);
  const result = await listOrders(env.DB, {
    q: url.searchParams.get('q')?.slice(0, 100) || undefined,
    payment: (url.searchParams.get('payment') as AdsOrder['payment_status']) || undefined,
    approval: (url.searchParams.get('approval') as ApprovalStatus) || undefined,
    campaign: (url.searchParams.get('campaign') as CampaignStatus) || undefined,
    page,
    perPage: PER_PAGE,
  });
  return json(result);
}

export async function adminOrderDetail(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const order = await getOrder(env.DB, id);
  if (!order) return json({ error: 'Order not found.' }, 404);
  return json({ order });
}

export async function adminCreative(request: Request, env: Env, id: string): Promise<Response> {
  // Only an authenticated admin may see submitted creatives; uploads are never
  // exposed through public R2 URLs.
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const order = await getOrder(env.DB, id);
  if (!order) return json({ error: 'Order not found.' }, 404);

  if (order.creative_format === 'text') {
    return json({ format: 'text', copy: order.ad_copy, destinationUrl: order.destination_url });
  }
  if (!order.creative_r2_key) return json({ error: 'No creative on file.' }, 404);

  const object = await env.CREATIVES.get(order.creative_r2_key);
  if (!object) return json({ error: 'Creative file is missing.' }, 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Admin retry path for a creative whose optimization failed (service over
 * quota or unavailable at submit time). Re-runs the same optimize pipeline and
 * swaps in the optimized WebP. Never touches payment or approval state.
 */
export async function adminReplaceCreative(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!requireCsrf(request, session)) return json({ error: 'Invalid CSRF token.' }, 403);

  const order = await getOrder(env.DB, id);
  if (!order) return json({ error: 'Order not found.' }, 404);
  if (order.creative_format !== 'image') return json({ error: 'This order uses a text creative.' }, 400);

  const formData = await request.formData();
  const file = formData.get('creative');
  if (!(file instanceof File)) return json({ error: 'No image file was uploaded.' }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = validateImageFile({ fileName: file.name, mimeType: file.type, bytes });
  if (!check.ok) return json({ error: check.error }, 400);

  const family = (check.extension === 'jpeg' ? 'jpg' : check.extension) as string;
  if (isAnimatedImage(bytes, family)) {
    return json({ error: 'Animated images are not supported. Please upload a static PNG, JPEG or WebP file.' }, 400);
  }

  const outcome = await optimizeCreative(env, bytes);
  if (outcome.kind !== 'ready' as const) {
    // Keep the existing failed state; surface the reason to the admin.
    return json({ error: outcome.error }, 503);
  }

  const newKey = `creatives/${id}/${crypto.randomUUID()}.webp`;
  try {
    await env.CREATIVES.put(newKey, outcome.bytes, { httpMetadata: { contentType: outcome.contentType } });
  } catch {
    return json({ error: 'The optimized image could not be stored. Please try again.' }, 500);
  }

  // Delete the previous creative (if any) only after the replacement lands.
  if (order.creative_r2_key) {
    await env.CREATIVES.delete(order.creative_r2_key).catch(() => {});
  }

  await setCreativeState(env.DB, id, {
    creative_r2_key: newKey,
    creative_status: 'ready',
    creative_width: outcome.width,
    creative_height: outcome.height,
    creative_optimization_error: null,
  });

  return json({ ok: true, creativeStatus: 'ready', width: outcome.width, height: outcome.height });
}

/* ---------- state-changing actions (CSRF-protected) ---------- */
function requireCsrf(request: Request, session: AdminSession): boolean {
  const token = request.headers.get('X-CSRF-Token');
  return !!token && timingSafeEqual(token, session.csrf_token);
}

export async function adminSetApproval(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!requireCsrf(request, session)) return json({ error: 'Invalid CSRF token.' }, 403);

  const body = await readJson(request);
  const status = body?.status;
  if (status !== 'approved' && status !== 'rejected') {
    return json({ error: 'Invalid approval status.' }, 400);
  }
  const now = new Date().toISOString();
  const res = await env.DB
    .prepare('UPDATE ads_orders SET approval_status = ?, updated_at = ? WHERE id = ?')
    .bind(status, now, id)
    .run();
  if (res.meta.changes === 0) return json({ error: 'Order not found.' }, 404);
  return json({ ok: true, approvalStatus: status });
}

export async function adminSetCampaign(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!requireCsrf(request, session)) return json({ error: 'Invalid CSRF token.' }, 403);

  const body = await readJson(request);
  const status = body?.status;
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status as string)) {
    return json({ error: 'Invalid campaign status.' }, 400);
  }

  const order = await getOrder(env.DB, id);
  if (!order) return json({ error: 'Order not found.' }, 404);

  let start = order.campaign_start;
  let end = order.campaign_end;
  if (status === 'scheduled' || status === 'active') {
    const requested = typeof body?.start === 'string' ? body.start.slice(0, 10) : '';
    const startStr = requested || new Date().toISOString().slice(0, 10);
    const parsed = new Date(`${startStr}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return json({ error: 'Invalid start date.' }, 400);
    start = parsed.toISOString();
    end = campaignEnd(start, order.duration_months);
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare('UPDATE ads_orders SET campaign_status = ?, campaign_start = ?, campaign_end = ?, updated_at = ? WHERE id = ?')
    .bind(status, start, end, now, id)
    .run();
  return json({ ok: true, campaignStatus: status, campaignStart: start, campaignEnd: end });
}

export async function adminAddNote(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!requireCsrf(request, session)) return json({ error: 'Invalid CSRF token.' }, 403);

  const body = await readJson(request);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note) return json({ error: 'Note is empty.' }, 400);
  if (note.length > MAX_NOTE_LENGTH) return json({ error: `Note is longer than ${MAX_NOTE_LENGTH} characters.` }, 400);

  const now = new Date().toISOString();
  const order = await getOrder(env.DB, id);
  const existing = order?.admin_notes ? `${order.admin_notes}\n` : '';
  const res = await env.DB
    .prepare('UPDATE ads_orders SET admin_notes = ?, updated_at = ? WHERE id = ?')
    .bind(`${existing}--- ${now}\n${note}`, now, id)
    .run();
  if (res.meta.changes === 0) return json({ error: 'Order not found.' }, 404);
  return json({ ok: true });
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
