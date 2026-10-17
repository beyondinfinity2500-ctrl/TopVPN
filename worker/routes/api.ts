/**
 * Public API routes for the advertising system:
 *   GET  /api/ads/health            safe configuration status (no secrets)
 *   GET  /api/ads/csrf              stateless CSRF token for the order form
 *   POST /api/ads/orders            create order -> Stripe Checkout URL
 *   GET  /api/ads/orders/:id        minimal public status (no customer data)
 *   POST /api/ads/webhook           Stripe webhook (signature-verified)
 */
import type { Env } from '../env';
import { cryptoEnabled, siteUrl } from '../env';
import { CURRENCY, PLACEMENT_LABELS, priceFor } from '../../src/lib/ads/pricing';
import {
  bumpRateLimit,
  getOrder,
  insertOrder,
  isWebhookEventProcessed,
  markNotPaidIfPending,
  markPaid,
  recordWebhookEvent,
  setEmailStatuses,
  setStripeSession,
  type AdsOrder,
} from '../db';
import { issueCsrfToken, verifyCsrfToken } from '../auth';
import {
  asCheckoutSession,
  createCheckoutSession,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../stripe';
import { sendOrderEmails, sendPaymentStatusEmail, sendAdminPaymentEmail } from '../email';
import { isAnimatedImage, validateImageFile, validateOrderInput, type ValidatedOrder } from '../validation';
import { optimizeCreative, type CreativeStatus } from '../images';

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

function newOrderId(): string {
  return `ORD-${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
}

const ORDER_RATE_LIMIT_WINDOW = 3600; // 1 hour
const ORDER_RATE_LIMIT_MAX = 5;

/* ---------- health ---------- */
export async function health(env: Env): Promise<Response> {
  const status: Record<string, unknown> = {
    ok: true,
    service: 'topvpn-ads',
    siteUrl: siteUrl(env),
    crypto: cryptoEnabled(env),
    stripe: !!env.STRIPE_SECRET_KEY,
    email: !!env.RESEND_API_KEY,
    admin: !!env.ADMIN_PASSWORD_HASH,
  };
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    status.database = 'ok';
  } catch (err) {
    // Detail goes to server-side logs only; the public body just says "error"
    // so binding/infrastructure internals are not exposed to anyone.
    console.error('topvpn-ads: D1 health check failed', err);
    status.ok = false;
    status.database = 'error';
  }
  try {
    await env.CREATIVES.head('topvpn-health-check');
    status.storage = 'ok';
  } catch (err) {
    console.error('topvpn-ads: R2 health check failed', err);
    status.ok = false;
    status.storage = 'error';
  }
  return json(status, status.ok ? 200 : 503);
}

/* ---------- CSRF token ---------- */
export async function issuePublicCsrf(env: Env): Promise<Response> {
  if (!env.SESSION_SECRET) {
    return json({ error: 'Ordering is temporarily unavailable (server not fully configured).' }, 503);
  }
  const { token, expiresAt } = await issueCsrfToken(env.SESSION_SECRET);
  return json({ token, expiresAt });
}

/* ---------- create order ---------- */
export async function createOrder(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.SESSION_SECRET) return json({ error: 'Ordering is temporarily unavailable.' }, 503);

  // 1. CSRF.
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!(await verifyCsrfToken(env.SESSION_SECRET, csrfToken))) {
    return json({ error: 'Invalid or missing CSRF token.' }, 403);
  }

  // 2. Rate limit per IP.
  const ip = clientIp(request);
  const rate = await bumpRateLimit(env.DB, `order:${ip}`, ORDER_RATE_LIMIT_WINDOW, ORDER_RATE_LIMIT_MAX);
  if (!rate.allowed) {
    return json({ error: 'Too many order submissions. Please try again later.' }, 429);
  }

  // 3. Parse + validate.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: 'Could not read the submitted form.' }, 400);
  }

  const validated = validateOrderInput({
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    website: String(formData.get('website') ?? ''),
    placement: String(formData.get('placement') ?? ''),
    duration: String(formData.get('duration') ?? ''),
    format: String(formData.get('format') ?? ''),
    terms: String(formData.get('terms') ?? ''),
    copy: String(formData.get('copy') ?? ''),
    destinationUrl: String(formData.get('destination_url') ?? ''),
    honeypot: String(formData.get('company_full_name') ?? ''),
  });
  if (!validated.ok) {
    return json({ error: 'Please correct the highlighted fields.', fieldErrors: validated.errors }, 400);
  }
  const value = validated.value as ValidatedOrder;

  // 4. Price is ALWAYS computed server-side; no client amount is ever read.
  const amountCents = Math.round(priceFor(value.placement, value.duration) * 100);
  const id = newOrderId();

  // 5. Creative handling (image -> optimize to WebP -> R2 with a unique key;
  //    never public). Only successfully optimized output is stored; an
  //    unoptimized original is never written to R2.
  let creativeR2Key: string | null = null;
  let creativeStatus: CreativeStatus = 'pending';
  let creativeWidth: number | null = null;
  let creativeHeight: number | null = null;
  let creativeError: string | null = null;
  if (value.format === 'image') {
    const file = formData.get('creative');
    if (!(file instanceof File)) {
      return json({ error: 'Please upload an image file.', fieldErrors: { creative: 'An image file is required.' } }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = validateImageFile({ fileName: file.name, mimeType: file.type, bytes });
    if (!check.ok) {
      return json({ error: check.error, fieldErrors: { creative: check.error } }, 400);
    }
    // Reject animation outright: the binding would otherwise silently keep only
    // the first frame, which the advertising terms do not permit.
    const family = (check.extension === 'jpeg' ? 'jpg' : check.extension) as string;
    if (isAnimatedImage(bytes, family)) {
      const error = 'Animated images are not supported. Please upload a static PNG, JPEG or WebP file.';
      return json({ error, fieldErrors: { creative: error } }, 400);
    }

    const outcome = await optimizeCreative(env, bytes);
    if (outcome.kind === 'invalid') {
      // Corrupt/undecodable upload: no order, no R2 object.
      return json({ error: outcome.error, fieldErrors: { creative: outcome.error } }, 400);
    }
    if (outcome.kind === 'unavailable') {
      // Optimization service over quota/unavailable: keep the order so nothing
      // is lost, store nothing, flag for the admin to retry.
      creativeStatus = 'failed';
      creativeError = outcome.error;
    } else {
      creativeR2Key = `creatives/${id}/${crypto.randomUUID()}.webp`;
      try {
        await env.CREATIVES.put(creativeR2Key, outcome.bytes, { httpMetadata: { contentType: outcome.contentType } });
        creativeStatus = 'ready';
        creativeWidth = outcome.width;
        creativeHeight = outcome.height;
      } catch {
        // Storage failed: the optimized bytes are gone, but the order itself is
        // kept with a failed creative so the admin can retry via replace.
        creativeR2Key = null;
        creativeStatus = 'failed';
        creativeError = 'The optimized image could not be stored. Please re-upload the creative.';
      }
    }
  }

  await insertOrder(env.DB, {
    id,
    customer_name: value.name,
    customer_email: value.email,
    customer_website: value.website,
    placement: value.placement,
    duration_months: value.duration,
    creative_format: value.format,
    ad_copy: value.copy,
    destination_url: value.destinationUrl,
    creative_r2_key: creativeR2Key,
    amount_cents: amountCents,
    currency: CURRENCY,
    creative_status: creativeStatus,
    creative_width: creativeWidth,
    creative_height: creativeHeight,
    creative_optimization_error: creativeError,
  });

  const order = await getOrder(env.DB, id);
  if (!order) return json({ error: 'Could not save the order. Please try again.' }, 500);
  return finalizeAfterCreation(env, ctx, order);
}

async function finalizeAfterCreation(env: Env, ctx: ExecutionContext, order: AdsOrder): Promise<Response> {
  const session = await createCheckoutSession(env, order);
  if (session.error || !session.url || !session.id) {
    // The order is kept as pending; the customer is told to expect contact.
    ctx.waitUntil(recordEmails(env, order.id, sendOrderEmails(env, order, 'Payment pending — checkout setup failed; our team will contact you.')));
    return json(
      {
        error: session.error || 'Payment setup is temporarily unavailable. Your order was received and we will contact you.',
        orderId: order.id,
      },
      503,
    );
  }
  await setStripeSession(env.DB, order.id, session.id);

  const paymentNote = 'Payment pending — complete the Stripe checkout to pay the full contract amount.';
  ctx.waitUntil(recordEmails(env, order.id, sendOrderEmails(env, order, paymentNote)));

  return json({ orderId: order.id, checkoutUrl: session.url });
}

async function recordEmails(env: Env, orderId: string, promise: Promise<{ customer: { status: string }; admin: { status: string } }>): Promise<void> {
  try {
    const results = await promise;
    await setEmailStatuses(env.DB, orderId, results.customer.status, results.admin.status);
  } catch {
    await setEmailStatuses(env.DB, orderId, 'failed:exception', 'failed:exception');
  }
}

/* ---------- public order status (minimal, no customer data) ---------- */
export async function publicOrderStatus(env: Env, id: string): Promise<Response> {
  const order = await getOrder(env.DB, id);
  if (!order) return json({ error: 'Order not found.' }, 404);
  return json({
    id: order.id,
    placement: order.placement,
    placementLabel: PLACEMENT_LABELS[order.placement],
    durationMonths: order.duration_months,
    creativeFormat: order.creative_format,
    amountCents: order.amount_cents,
    currency: order.currency,
    paymentStatus: order.payment_status,
    approvalStatus: order.approval_status,
    campaignStatus: order.campaign_status,
    createdAt: order.created_at,
  });
}

/* ---------- Stripe webhook ---------- */

/**
 * Records a verified payment and notifies the customer + admin exactly once.
 * Returns false when the order was already paid (e.g. a duplicate event), so a
 * replay can never send a second confirmation pair.
 */
async function recordVerifiedPayment(
  env: Env,
  ctx: ExecutionContext,
  order: AdsOrder,
  reference: string,
): Promise<boolean> {
  const changed = await markPaid(env.DB, order.id, reference);
  if (!changed) return false;
  ctx.waitUntil(
    (async () => {
      const paid = await getOrder(env.DB, order.id);
      if (!paid) return;
      const customer = await sendPaymentStatusEmail(
        env,
        paid,
        'Payment received. Your campaign is now subject to advertising approval.',
      );
      const admin = await sendAdminPaymentEmail(env, paid, 'Payment received (verified Stripe event).');
      await setEmailStatuses(env.DB, order.id, customer.status, admin.status);
    })(),
  );
  return true;
}

export async function stripeWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Webhook not configured.' }, 503);

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';
  if (!(await verifyWebhookSignature({ secret: env.STRIPE_WEBHOOK_SECRET, rawBody, signatureHeader: signature }))) {
    return json({ error: 'Invalid signature.' }, 401);
  }

  const event = parseWebhookEvent(rawBody);
  if (!event) return json({ error: 'Malformed event.' }, 400);

  // Idempotency: a replayed event must never re-process an order.
  if (await isWebhookEventProcessed(env.DB, event.id)) {
    return json({ status: 'duplicate' });
  }

  const orderId = orderIdFromEvent(event);
  const order = orderId ? await getOrder(env.DB, orderId) : null;

  if (order) {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = asCheckoutSession(event.data.object);
        if (session?.payment_status === 'paid') {
          await recordVerifiedPayment(env, ctx, order, session.payment_intent ?? session.id);
        }
        // A completed session that is not yet paid means an asynchronous payment
        // (e.g. bank transfer) is still in flight. The order stays pending until
        // a verified async_payment_succeeded / async_payment_failed event lands;
        // we never assume the payment failed just because it is not instant.
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        const session = asCheckoutSession(event.data.object);
        if (session) {
          await recordVerifiedPayment(env, ctx, order, session.payment_intent ?? session.id);
        }
        break;
      }
      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed':
        // Only ever transitions a still-pending order; a verified payment can
        // never be overwritten by a later failure event.
        await markNotPaidIfPending(env.DB, order.id, 'failed');
        break;
      case 'checkout.session.expired':
        await markNotPaidIfPending(env.DB, order.id, 'expired');
        break;
      default:
        break;
    }
  }

  await recordWebhookEvent(env.DB, event.id, orderId, event.type);
  return json({ status: 'processed' });
}

function orderIdFromEvent(event: { data: { object: Record<string, unknown> } }): string | null {
  const obj = event.data.object;
  const metadata = obj.metadata as Record<string, string> | undefined;
  const fromMeta = metadata?.order_id;
  if (typeof fromMeta === 'string' && fromMeta.startsWith('ORD-')) return fromMeta;
  const fromRef = obj.client_reference_id;
  if (typeof fromRef === 'string' && fromRef.startsWith('ORD-')) return fromRef;
  return null;
}
