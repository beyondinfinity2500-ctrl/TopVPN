/**
 * Sandbox-only Stripe Checkout for VPN orders.
 *
 * Isolation from advertising:
 *   - separate module, separate route (`/api/vpn/checkout`), separate metadata
 *     namespace (`domain=vpn`), and its own signing secret on the webhook;
 *   - it never imports the advertising checkout/order code.
 *
 * Hard safety rules:
 *   - refuses to run without `VPN_SANDBOX_CHECKOUT_ENABLED=true`;
 *   - refuses any key that is not `sk_test_...` (live mode cannot activate);
 *   - prices come only from the stored order (which itself came from
 *     src/lib/plans.ts), never from the request body;
 *   - the plan is a one-time purchase period (mode=payment), no subscriptions.
 */
import type { Env } from '../env';
import { getPlan, isPlanId } from '../../src/lib/plans';
import { DEFAULTS, siteUrl } from '../env';
import type { VpnOrderRow } from './repo';

const STRIPE_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';

export type CheckoutConfig =
  | { ok: true; secretKey: string }
  | { ok: false; reason: 'sandbox_checkout_disabled' | 'stripe_not_configured' | 'live_key_refused' };

export function sandboxCheckoutConfig(env: Env): CheckoutConfig {
  if (env.VPN_SANDBOX_CHECKOUT_ENABLED !== 'true') {
    return { ok: false, reason: 'sandbox_checkout_disabled' };
  }
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return { ok: false, reason: 'stripe_not_configured' };
  // Live keys are refused at the code level, not just by configuration.
  if (!secretKey.startsWith('sk_test_')) return { ok: false, reason: 'live_key_refused' };
  return { ok: true, secretKey };
}

export type CheckoutSessionResult =
  | { ok: true; id: string; url: string }
  | { ok: false; reason: string };

/** Build the form body for a one-time Checkout Session. Exported for tests. */
export function vpnCheckoutParams(
  env: Env,
  order: VpnOrderRow,
  extraMetadata: Record<string, string> = {},
): URLSearchParams {
  if (!isPlanId(order.plan_id)) throw new Error('vpnCheckoutParams: invalid plan on order');
  const plan = getPlan(order.plan_id);
  const base = siteUrl(env) || DEFAULTS.siteUrl;
  const months = order.interval_months;
  const label = `${months} month${months === 1 ? '' : 's'}`;

  const params = new URLSearchParams();
  params.set('mode', 'payment'); // one-time period; no subscription/renewal
  params.set('success_url', `${base}/checkout/success?order=${encodeURIComponent(order.id)}`);
  params.set('cancel_url', `${base}/checkout/cancel?order=${encodeURIComponent(order.id)}`);
  params.set('customer_email', order.customer_email);
  params.set('client_reference_id', order.id);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', order.currency.toLowerCase());
  params.set('line_items[0][price_data][unit_amount]', String(order.amount_cents));
  params.set('line_items[0][price_data][product_data][name]', `TopVPN Premium — ${plan.name}`);
  params.set(
    'line_items[0][price_data][product_data][description]',
    `One-time payment for ${label}. No automatic renewal.`,
  );
  params.set('metadata[domain]', 'vpn');
  params.set('metadata[vpn_order_id]', order.id);
  for (const [key, value] of Object.entries(extraMetadata)) {
    params.set(`metadata[${key}]`, value);
  }
  params.set('payment_intent_data[metadata][domain]', 'vpn');
  params.set('payment_intent_data[metadata][vpn_order_id]', order.id);
  for (const [key, value] of Object.entries(extraMetadata)) {
    params.set(`payment_intent_data[metadata][${key}]`, value);
  }
  return params;
}

export interface StripeFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Best-effort: close a session we can no longer associate with an order. */
export async function expireVpnCheckoutSession(
  env: Env,
  sessionId: string,
  options: StripeFetchOptions = {},
): Promise<void> {
  const config = sandboxCheckoutConfig(env);
  if (!config.ok) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${STRIPE_SESSIONS}/${encodeURIComponent(sessionId)}/expire`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.secretKey}` },
    });
  } catch {
    // Ignore: the order is already cancelled; this only reduces risk.
  }
}

export async function createVpnCheckoutSession(
  env: Env,
  order: VpnOrderRow,
  options: StripeFetchOptions = {},
  extraMetadata: Record<string, string> = {},
): Promise<CheckoutSessionResult> {
  const config = sandboxCheckoutConfig(env);
  if (!config.ok) return { ok: false, reason: config.reason };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetchImpl(STRIPE_SESSIONS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': extraMetadata.renewal ? `vpn-renew:${order.id}` : `vpn-checkout:${order.id}`,
      },
      body: vpnCheckoutParams(env, order, extraMetadata).toString(),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      // Never echo the key. Stripe's message is truncated and sanitized.
      let message = 'Stripe rejected the checkout session.';
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const error = (parsed as { error?: { message?: unknown } }).error;
        if (error && typeof error.message === 'string') {
          message = error.message.slice(0, 200).split(config.secretKey).join('[redacted]');
        }
      }
      return { ok: false, reason: `stripe_${response.status}: ${message}` };
    }

    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'stripe_invalid_response' };
    const session = parsed as { id?: unknown; url?: unknown };
    if (typeof session.id !== 'string' || typeof session.url !== 'string') {
      return { ok: false, reason: 'stripe_invalid_response' };
    }
    return { ok: true, id: session.id, url: session.url };
  } catch {
    return { ok: false, reason: 'stripe_timeout' };
  } finally {
    clearTimeout(timer);
  }
}
