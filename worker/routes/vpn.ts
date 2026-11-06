/**
 * VPN sales routes (sandbox foundation).
 *
 *   GET  /api/vpn/plans                          public plan catalog
 *   POST /api/vpn/orders                         create a pending order (flag-gated)
 *   POST /api/vpn/webhook                        verified payment/refund events
 *   GET  /admin/api/vpn/orders/:id               admin-only order/provisioning state
 *   POST /admin/api/vpn/orders/:id/reconcile     admin-only safe reconciliation
 *   POST /admin/api/vpn/orders/:id/provision     admin-only retry (no account known)
 *
 * There is deliberately NO customer-authenticated read route and NO checkout
 * redirect: customer identity is not implemented yet. No route calls the
 * provider directly; only worker/vpn/service.ts does.
 */
import type { Env } from '../env';
import { json } from './api';
import { isValidEmail } from '../validation';
import { CURRENCY, isPlanId, planList } from '../../src/lib/plans';
import { getSession } from '../db';
import { SESSION_COOKIE, timingSafeEqual } from '../auth';
import { parseWebhookEvent, verifyWebhookSignature } from '../stripe';
import { getCustomerSessionFromToken } from '../customer/auth';
import {
  attachVpnCheckoutSession,
  cancelVpnOrder,
  countVpnProvisioningAttempts,
  getVpnOrder,
  getVpnOrderByIdempotencyKey,
  getVpnOrderByPaymentIntent,
  getVpnOrderBySession,
  listRecoverableVpnOrders,
  markVpnPaid,
  markVpnPaymentEventProcessed,
  markVpnRefunded,
  recordVpnOrderEvent,
  recordVpnPaymentEvent,
  releaseVpnPaymentEvent,
  setVpnFailureNote,
} from '../vpn/repo';
import { createVpnOrder, provisionVpnOrder, reconcileVpnOrder } from '../vpn/service';
import { recoverVpnOrder, MAX_PROVISIONING_ATTEMPTS } from '../vpn/recovery';
import { createVpnCheckoutSession, expireVpnCheckoutSession, sandboxCheckoutConfig, vpnCheckoutParams } from '../vpn/stripe-checkout';
import { checkRenewalEligibility, extendVpnExpiry } from '../vpn/renewal';

const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
const REFUND_EVENTS = new Set(['charge.refunded', 'refund.created', 'refund.updated']);
const DISPUTE_EVENTS = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed']);
const PRICE_FIELDS = ['amount', 'amountCents', 'amount_cents', 'price', 'currency', 'intervalMonths', 'interval_months'];

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function customerCookieToken(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'topvpn_customer_session') return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function currentCustomer(request: Request, env: Env) {
  return getCustomerSessionFromToken(env, customerCookieToken(request));
}

async function readFormField(request: Request, field: string): Promise<string> {
  try {
    const text = await request.text();
    const params = new URLSearchParams(text);
    return params.get(field) ?? '';
  } catch {
    return '';
  }
}

function salesEnabled(env: Env): boolean {
  return env.VPN_SALES_ENABLED === 'true';
}

/* ---------- public plan catalog ---------- */

export async function vpnPlans(env: Env): Promise<Response> {
  return json({
    currency: CURRENCY,
    checkout: salesEnabled(env) ? 'sandbox' : 'closed',
    // The one-time intro price is disabled until verified customer identity
    // exists; without it the discount can be repeated with new emails.
    introEnabled: false,
    plans: planList().map((plan) => ({
      id: plan.id,
      name: plan.name,
      intervalMonths: plan.intervalMonths,
      amountCents: plan.regularCents,
      introCents: plan.introCents ?? null,
    })),
  });
}

/* ---------- order creation ---------- */

export async function createVpnOrderRoute(request: Request, env: Env): Promise<Response> {
  if (!salesEnabled(env)) return json({ error: 'VPN checkout is not open yet.' }, 503);

  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    body = parsed;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (PRICE_FIELDS.some((field) => field in body)) {
    return json({ error: 'Price and duration are calculated by the server.' }, 422);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : null;
  const planId = typeof body.planId === 'string' ? body.planId : '';

  if (!isValidEmail(email)) return json({ error: 'A valid email address is required.' }, 422);
  if (name && name.length > 100) return json({ error: 'Name is too long.' }, 422);
  if (!isPlanId(planId)) return json({ error: 'Unknown plan.' }, 422);

  // Fixed-window abuse guard. Uses the generic D1 rate-limit table with a
  // VPN-specific key; no advertising order data is read or written.
  const ip = clientIp(request);
  const hourBucket = Math.floor(Date.now() / 1000 / 3600);
  const window = await env.DB.prepare(
    `INSERT INTO ads_rate_limits (key, bucket, count, window_start) VALUES (?, ?, 1, ?)
       ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(`vpn-order:${ip}`, hourBucket, hourBucket)
    .first<{ count: number }>();
  if ((window?.count ?? 1) > 10) return json({ error: 'Too many order attempts. Try again later.' }, 429);

  // Intro pricing is intentionally NOT applied: it cannot be enforced as
  // one-time without verified identity. See docs/PLATFORM_IMPLEMENTATION.md.
  const order = await createVpnOrder(env, { email, name, planId, introEligible: false });

  return json(
    {
      orderId: order.id,
      planId: order.plan_id,
      amountCents: order.amount_cents,
      currency: order.currency,
      orderStatus: order.order_status,
      paymentStatus: order.payment_status,
      introApplied: false,
    },
    201,
  );
}

/**
 * Renew an existing paid order by creating a new one-time checkout session.
 * Extends the existing entitlement expiry by the plan interval; does not create
 * a subscription or recurring charge.
 */
export async function renewOrderRoute(request: Request, env: Env, id: string): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return json({ error: 'Not authenticated.' }, 401);

  const csrf = await readFormField(request, 'csrf');
  if (!csrf || !timingSafeEqual(csrf, session.csrfToken)) {
    return json({ error: 'CSRF verification failed.' }, 403);
  }

  const order = await getVpnOrder(env.DB, id);
  if (!order) return json({ error: 'Order not found.' }, 404);

  // Ownership check: only the customer whose email placed the order can renew it.
  if (order.customer_email.toLowerCase() !== session.email.toLowerCase()) {
    return json({ error: 'Not authorized.' }, 403);
  }

  const eligibility = checkRenewalEligibility(order, new Date());
  if (!eligibility.eligible) {
    return json(
      {
        error: eligibility.reason,
        days_remaining: eligibility.days_remaining,
        renewalPriceCents: eligibility.renewalPriceCents,
      },
      409,
    );
  }

  const config = sandboxCheckoutConfig(env);
  if (!config.ok) return json({ error: config.reason }, 503);

  const result = await createVpnCheckoutSession(env, order, {}, { renewal: '1' });
  if (!result.ok) {
    return json({ error: result.reason }, 502);
  }

  return new Response(null, {
    status: 303,
    headers: { Location: result.url, 'Cache-Control': 'no-store' },
  });
}

/* ---------- sandbox checkout (order + Stripe test session) ---------- */

export interface VpnCheckoutDeps {
  fetchImpl?: typeof fetch;
}

export async function vpnCheckout(request: Request, env: Env, deps: VpnCheckoutDeps = {}): Promise<Response> {
  if (!salesEnabled(env)) return json({ error: 'VPN checkout is not open yet.' }, 503);
  const config = sandboxCheckoutConfig(env);
  if (!config.ok) return json({ error: 'VPN checkout is not available.' }, 503);

  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    body = parsed;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (PRICE_FIELDS.some((field) => field in body)) {
    return json({ error: 'Price and duration are calculated by the server.' }, 422);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : null;
  const planId = typeof body.planId === 'string' ? body.planId : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';

  if (!isValidEmail(email)) return json({ error: 'A valid email address is required.' }, 422);
  if (name && name.length > 100) return json({ error: 'Name is too long.' }, 422);
  if (!isPlanId(planId)) return json({ error: 'Unknown plan.' }, 422);
  if (!idempotencyKey) return json({ error: 'An idempotency key is required.' }, 422);
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(idempotencyKey)) {
    return json({ error: 'Invalid idempotency key.' }, 422);
  }

  const ip = clientIp(request);
  const hourBucket = Math.floor(Date.now() / 1000 / 3600);
  const window = await env.DB.prepare(
    `INSERT INTO ads_rate_limits (key, bucket, count, window_start) VALUES (?, ?, 1, ?)
       ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(`vpn-order:${ip}`, hourBucket, hourBucket)
    .first<{ count: number }>();
  if ((window?.count ?? 1) > 10) return json({ error: 'Too many checkout attempts. Try again later.' }, 429);

  const existing = await getVpnOrderByIdempotencyKey(env.DB, idempotencyKey);
  let order: Awaited<ReturnType<typeof createVpnOrder>>;
  if (existing) {
    // A key may only be reused for the same purchase intent.
    const sameIntent =
      existing.customer_email.toLowerCase() === email.toLowerCase() && existing.plan_id === planId;
    if (!sameIntent) return json({ error: 'Idempotency key already used for a different request.' }, 409);
    if (existing.stripe_checkout_url) {
      // Never hand back a payable URL for a paid/refunded/cancelled order.
      if (existing.order_status !== 'pending_payment' || existing.payment_status !== 'unpaid') {
        return json({ error: 'This order is no longer awaiting payment.' }, 409);
      }
      return json(
        {
          orderId: existing.id,
          checkoutUrl: existing.stripe_checkout_url,
          amountCents: existing.amount_cents,
          currency: existing.currency,
          reused: true,
        },
        200,
      );
    }
    if (existing.order_status !== 'pending_payment' || existing.payment_status !== 'unpaid') {
      return json({ error: 'Checkout is already being prepared for this request.' }, 409);
    }
    // Previous Stripe session creation failed; retry on the same pending order.
    order = existing;
  } else {
    const now = new Date().toISOString();
    try {
      order = await createVpnOrder(env, {
        email,
        name,
        planId,
        introEligible: false,
        idempotencyKey,
      });
    } catch {
      // A concurrent request with the same idempotency key won the unique insert.
      const raced = await getVpnOrderByIdempotencyKey(env.DB, idempotencyKey);
      if (raced?.stripe_checkout_url) {
        return json(
          {
            orderId: raced.id,
            checkoutUrl: raced.stripe_checkout_url,
            amountCents: raced.amount_cents,
            currency: raced.currency,
            reused: true,
          },
          200,
        );
      }
      return json({ error: 'Checkout conflict. Please try again.' }, 409);
    }
  }

  const now = new Date().toISOString();
  const session = await createVpnCheckoutSession(env, order, { fetchImpl: deps.fetchImpl });
  if (!session.ok) {
    // Keep the pending order so the same idempotency key can retry safely.
    await setVpnFailureNote(env.DB, order, 'checkout_creation_failed', now);
    const reason = session.reason.includes(':') ? 'stripe_error' : session.reason;
    return json({ error: 'Could not start checkout.', reason }, 502);
  }

  let attached = false;
  try {
    attached = await attachVpnCheckoutSession(env.DB, order.id, session.id, session.url, now);
  } catch {
    attached = false;
  }
  if (!attached) {
    // A concurrent request may have attached the same Stripe session first.
    // Return it instead of expiring a live, payable URL.
    const current = await getVpnOrder(env.DB, order.id);
    if (current?.stripe_checkout_url) {
      return json(
        {
          orderId: current.id,
          checkoutUrl: current.stripe_checkout_url,
          amountCents: current.amount_cents,
          currency: current.currency,
          reused: true,
        },
        200,
      );
    }
    // Never leave a payable session for an order we cannot track.
    await expireVpnCheckoutSession(env, session.id, { fetchImpl: deps.fetchImpl });
    await cancelVpnOrder(env.DB, order.id, now);
    return json({ error: 'Checkout conflict. Please try again.' }, 409);
  }

  return json(
    {
      orderId: order.id,
      checkoutUrl: session.url,
      amountCents: order.amount_cents,
      currency: order.currency,
      introApplied: false,
    },
    201,
  );
}

/* ---------- admin: read + reconcile + retry ---------- */
async function requireAdmin(request: Request, env: Env) {
  const token = cookieToken(request);
  if (!token) {
    return null;
  }
  const sess = await getSession(env.DB, token);
  return sess;
}

async function requireAdminCsrf(request: Request, env: Env) {
  const session = await requireAdmin(request, env);
  if (!session) return null;
  const csrf = request.headers.get('X-CSRF-Token') ?? '';
  if (!csrf || !timingSafeEqual(csrf, session.csrf_token)) return null;
  return session;
}

export async function vpnAdminOrder(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (!session) return json({ error: 'Unauthorized.' }, 401);

  const order = await getVpnOrder(env.DB, id);
  if (!order) return json({ error: 'Not found.' }, 404);

  return json({
    orderId: order.id,
    customerEmail: order.customer_email,
    customerName: order.customer_name,
    planId: order.plan_id,
    intervalMonths: order.interval_months,
    amountCents: order.amount_cents,
    currency: order.currency,
    orderStatus: order.order_status,
    paymentStatus: order.payment_status,
    provisioningStatus: order.provisioning_status,
    subscriptionStatus: order.subscription_status,
    providerAccountId: order.provider_account_id,
    providerUsername: order.provider_username,
    expireAt: order.expire_at,
    failureReason: order.failure_reason,
    createdAt: order.created_at,
    paidAt: order.paid_at,
  });
}

export async function vpnAdminReconcile(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireAdminCsrf(request, env))) return json({ error: 'Unauthorized.' }, 403);
  const outcome = await reconcileVpnOrder(env, id);
  const status =
    outcome.status === 'not_found'
      ? 404
      : outcome.status === 'provider_not_configured'
        ? 503
        : outcome.status === 'not_reconcilable'
          ? 409
          : 200;
  return json(outcome, status);
}

export async function vpnAdminProvision(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireAdminCsrf(request, env))) return json({ error: 'Unauthorized.' }, 403);
  if ((await countVpnProvisioningAttempts(env.DB, id)) >= MAX_PROVISIONING_ATTEMPTS) {
    return json({ error: 'Attempt limit reached. Review this order manually.' }, 409);
  }
  const outcome = await provisionVpnOrder(env, id);
  const status =
    outcome.status === 'not_found'
      ? 404
      : outcome.status === 'not_paid' || outcome.status === 'claim_exists' || outcome.status === 'skipped'
        ? 409
        : 200;
  return json(outcome, status);
}

export async function vpnAdminRecoveryList(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return json({ error: 'Unauthorized.' }, 401);
  const orders = await listRecoverableVpnOrders(env.DB, 100);
  const rows = [];
  for (const order of orders) {
    rows.push({ ...order, attempts: await countVpnProvisioningAttempts(env.DB, order.id) });
  }
  return json({ orders: rows });
}

export async function vpnAdminRecover(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireAdminCsrf(request, env))) return json({ error: 'Unauthorized.' }, 403);
  const result = await recoverVpnOrder(env, id);
  const status =
    result.status === 'not_found' ? 404 : result.status === 'manual_review' ? 409 : 200;
  return json(result, status);
}

/* ---------- payment webhook ---------- */

async function resolveVpnOrder(
  env: Env,
  eventType: string,
  object: Record<string, unknown>,
  metadata: Record<string, string>,
) {
  // An explicit VPN order id wins and is authoritative; never fall back to a
  // PaymentIntent match for a different/mistyped id. Only accept IDs that
  // follow the VPN order prefix to prevent cross-domain order lookup.
  if (metadata.vpn_order_id && metadata.vpn_order_id.startsWith('ORD-VPN-')) {
    return getVpnOrder(env.DB, metadata.vpn_order_id);
  }

  const paymentIntent = typeof object.payment_intent === 'string' ? object.payment_intent : null;
  if (paymentIntent) {
    const byIntent = await getVpnOrderByPaymentIntent(env.DB, paymentIntent);
    if (byIntent) return byIntent;
  }

  if (eventType.startsWith('checkout.session') && typeof object.id === 'string') {
    return getVpnOrderBySession(env.DB, object.id);
  }
  return null;
}

export async function vpnStripeWebhook(request: Request, env: Env): Promise<Response> {
  // NOTE: intentionally NOT gated on VPN_SALES_ENABLED. Closing checkout must not
  // stop payment/refund events for orders that already exist.
  const secret = env.STRIPE_VPN_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'VPN webhook is not configured.' }, 503);

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';
  const valid = await verifyWebhookSignature({ secret, rawBody, signatureHeader: signature });
  if (!valid) return json({ error: 'Invalid signature.' }, 400);

  const event = parseWebhookEvent(rawBody);
  if (!event) return json({ error: 'Invalid event payload.' }, 400);

  const object = event.data.object as Record<string, unknown>;
  const metadata = (object.metadata ?? {}) as Record<string, string>;

  // Domain isolation: an event explicitly tagged for another product is never
  // allowed to touch a VPN order, even if it carries a vpn_order_id key.
  if (metadata.domain && metadata.domain !== 'vpn') return json({ ok: true, ignored: 'not_vpn' });

  // Defense-in-depth: events with no VPN markers and no lookup keys (payment
  // intent or session id) cannot identify a VPN order and are ignored rather
  // than risking a cross-domain match.
  const hasVpnMarker = metadata.domain === 'vpn' || !!metadata.vpn_order_id;
  const hasLookupKey =
    typeof object.payment_intent === 'string' ||
    (event.type.startsWith('checkout.session') && typeof object.id === 'string');
  if (!hasVpnMarker && !hasLookupKey) return json({ ok: true, ignored: 'not_vpn' });

  const order = await resolveVpnOrder(env, event.type, object, metadata);

  if (!order) {
    // Only retry when the event is explicitly a VPN event; ads/other events on
    // the shared Stripe account are ignored (no retry storm).
    if (metadata.domain !== 'vpn' && !metadata.vpn_order_id) return json({ ok: true, ignored: 'not_vpn' });
    return json({ error: 'Unknown VPN order.' }, 500);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const amountCents =
    typeof object.amount_total === 'number'
      ? object.amount_total
      : typeof object.amount === 'number'
        ? object.amount
        : null;
  const currency = typeof object.currency === 'string' ? object.currency.toUpperCase() : null;

  const recorded = await recordVpnPaymentEvent(env.DB, {
    eventId: event.id,
    orderId: order.id,
    eventType: event.type,
    amountCents,
    currency,
    now: nowIso,
  });
  if (!recorded) return json({ ok: true, duplicate: true });

  try {
    // Non-terminal failures: record for support/visibility, but never mark a
    // payment as paid/refunded and never provision an account.
    if (event.type === 'checkout.session.async_payment_failed') {
      await setVpnFailureNote(env.DB, order, 'async_payment_failed', nowIso);
      await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
      return json({ ok: true, ignored: 'async_payment_failed' });
    }
    if (event.type === 'refund.failed') {
      await setVpnFailureNote(env.DB, order, 'refund_failed', nowIso);
      await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
      return json({ ok: true, ignored: 'refund_failed' });
    }

    // Chargebacks/disputes: record for support visibility only. Never revoke
    // provider access automatically (requires an approved product policy).
    if (DISPUTE_EVENTS.has(event.type)) {
      await recordVpnOrderEvent(env.DB, {
        orderId: order.id,
        from: order.order_status,
        to: order.order_status,
        reason: `dispute_${event.type.split('.').pop() ?? 'event'}`,
        now: nowIso,
      });
      await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
      return json({ ok: true, ignored: 'dispute_recorded' });
    }

    if (PAID_EVENTS.has(event.type)) {
      if (object.payment_status !== 'paid') {
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, ignored: 'payment_not_paid' });
      }
      if (typeof object.amount_total !== 'number' || typeof object.currency !== 'string') {
        await releaseVpnPaymentEvent(env.DB, event.id);
        return json({ error: 'Payment event is missing the charged amount.' }, 400);
      }
      if (object.amount_total !== order.amount_cents) {
        await setVpnFailureNote(env.DB, order, 'payment_amount_mismatch', nowIso);
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, ignored: 'amount_mismatch' });
      }
      if (object.currency.toUpperCase() !== order.currency) {
        await setVpnFailureNote(env.DB, order, 'payment_currency_mismatch', nowIso);
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, ignored: 'currency_mismatch' });
      }

      // Renewal: extend existing entitlement expiry. Order is already paid,
      // so we don't call markVpnPaid or provisionVpnOrder.
      if (metadata.renewal === '1') {
        const extended = await extendVpnExpiry(env.DB, order.id, nowIso);
        if (!extended) {
          await recordVpnOrderEvent(env.DB, {
            orderId: order.id,
            from: order.order_status,
            to: order.order_status,
            reason: 'renewal_payment_not_extended',
            now: nowIso,
          });
        }
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, renewed: extended });
      }

      const paid = await markVpnPaid(env.DB, order.id, {
        sessionId: typeof object.id === 'string' ? object.id : null,
        paymentIntent: typeof object.payment_intent === 'string' ? object.payment_intent : null,
        now: nowIso,
      });

      const current = await getVpnOrder(env.DB, order.id);
      if (current && current.order_status === 'cancelled') {
        // Money captured on a cancelled order is an anomaly: keep an audit row
        // so an operator can refund it (do not silently drop it).
        await recordVpnOrderEvent(env.DB, {
          orderId: order.id,
          from: 'cancelled',
          to: 'cancelled',
          reason: 'paid_event_on_cancelled_order',
          now: nowIso,
        });
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, paid: false, ignored: 'order_cancelled', needsReview: true });
      }
      if (current && current.order_status === 'refunded') {
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, paid: false, ignored: 'order_refunded' });
      }

      // A second checkout session for an already-paid order is a money risk.
      if (!paid && current?.payment_status === 'paid' && current.stripe_session_id && object.id && current.stripe_session_id !== object.id) {
        await recordVpnOrderEvent(env.DB, {
          orderId: order.id,
          from: current.order_status,
          to: current.order_status,
          reason: 'duplicate_payment_detected',
          now: nowIso,
        });
      }

      const provisioning = await provisionVpnOrder(env, order.id, { now });
      await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
      return json({ ok: true, paid, provisioning: provisioning.status });
    }

    if (REFUND_EVENTS.has(event.type)) {
      if (event.type.startsWith('refund.') && object.status !== 'succeeded') {
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, ignored: 'refund_not_succeeded' });
      }
      const refundAmount =
        typeof object.amount_refunded === 'number'
          ? object.amount_refunded
          : typeof object.amount === 'number'
            ? object.amount
            : null;
      if (refundAmount === null) {
        await releaseVpnPaymentEvent(env.DB, event.id);
        return json({ error: 'Refund event is missing the refunded amount.' }, 400);
      }
      if (refundAmount < order.amount_cents) {
        await recordVpnOrderEvent(env.DB, {
          orderId: order.id,
          from: order.order_status,
          to: order.order_status,
          reason: 'partial_refund_manual_review',
          now: nowIso,
        });
        await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
        return json({ ok: true, ignored: 'partial_refund' });
      }
      const refunded = await markVpnRefunded(env.DB, order.id, nowIso);
      await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
      return json({ ok: true, refunded });
    }

    await markVpnPaymentEventProcessed(env.DB, event.id, nowIso);
    return json({ ok: true, ignored: 'unhandled_event' });
  } catch {
    // Let Stripe retry: remove the unprocessed event, keep any committed state.
    await releaseVpnPaymentEvent(env.DB, event.id);
    return json({ error: 'Payment processing failed.' }, 500);
  }
}



