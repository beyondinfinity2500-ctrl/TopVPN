/**
 * PayPal one-time payment support for VPN orders, alongside Stripe.
 *
 * Safety model (mirrors worker/vpn/stripe-checkout.ts):
 *   - entirely separate module and routes (/api/vpn/paypal/*);
 *   - disabled unless PAYPAL_ENABLED === "true" AND credentials exist;
 *   - the API base defaults to the SANDBOX host; a live host must be configured
 *     explicitly (owner decision) and refuses to run with sandbox credentials;
 *   - amounts come only from the stored order (server-calculated), never from
 *     the request or from PayPal's payload;
 *   - one-time payments only: no billing plans, no subscriptions, no vaulting,
 *     no future charges. Renewal is always a new customer-initiated order.
 */
import type { Env } from '../env';
import type { VpnOrderRow } from './repo';

export type PayPalConfig =
  | { ok: true; apiBase: string; clientId: string; clientSecret: string; webhookId: string }
  | { ok: false; reason: 'paypal_disabled' | 'paypal_not_configured' | 'paypal_live_refused' };

export function paypalConfig(env: Env): PayPalConfig {
  if (env.PAYPAL_ENABLED !== 'true') return { ok: false, reason: 'paypal_disabled' };
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID } = env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return { ok: false, reason: 'paypal_not_configured' };

  const apiBase = (env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
  // The live host is refused unless the owner has explicitly approved it with a
  // second switch — sandbox credentials must never reach production silently.
  if (apiBase.includes('api-m.paypal.com') && env.PAYPAL_ALLOW_LIVE !== 'true') {
    return { ok: false, reason: 'paypal_live_refused' };
  }
  return { ok: true, apiBase, clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, webhookId: PAYPAL_WEBHOOK_ID ?? '' };
}

/** Cents -> PayPal amount string ("900" -> "9.00"). */
export function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** PayPal amount string -> cents ("3.00" -> 300). Returns NaN when malformed. */
export function amountToCents(value: string): number {
  return Math.round(Number.parseFloat(value) * 100);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export interface PayPalFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getAccessToken(env: Env, config: Extract<PayPalConfig, { ok: true }>, options: PayPalFetchOptions): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) return cachedToken.value;

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(`${config.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || typeof data?.access_token !== 'string') return null;
    cachedToken = {
      value: data.access_token,
      expiresAt: now + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : 30 * 60_000),
    };
    return cachedToken.value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function paypalOrderBody(order: VpnOrderRow): Record<string, unknown> {
  const months = order.interval_months;
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: order.id, // authoritative VPN order link on every capture event
        description: `TopVPN Premium — ${months} month${months === 1 ? '' : 's'} (one-time)`,
        amount: { currency_code: order.currency, value: centsToAmount(order.amount_cents) },
      },
    ],
    // One-time checkout only. No billing_context/subscription/vault fields.
    application_context: {
      brand_name: 'TopVPN',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
    },
  };
}

export type PayPalOrderResult =
  | { ok: true; id: string; approveUrl: string }
  | { ok: false; reason: string };

export async function createPayPalOrder(
  env: Env,
  order: VpnOrderRow,
  options: PayPalFetchOptions = {},
): Promise<PayPalOrderResult> {
  const config = paypalConfig(env);
  if (!config.ok) return { ok: false, reason: config.reason };
  const token = await getAccessToken(env, config, options);
  if (!token) return { ok: false, reason: 'paypal_auth_failed' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(`${config.apiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `vpn-${order.id}`, // provider-side idempotency
      },
      body: JSON.stringify(paypalOrderBody(order)),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as
      | { id?: string; links?: { rel: string; href: string }[] }
      | null;
    if (!res.ok || typeof data?.id !== 'string' || !Array.isArray(data.links)) {
      return { ok: false, reason: `paypal_${res.status}` };
    }
    const approve = data.links.find((l) => l.rel === 'approve');
    if (!approve) return { ok: false, reason: 'paypal_no_approve_link' };
    return { ok: true, id: data.id, approveUrl: approve.href };
  } catch {
    return { ok: false, reason: 'paypal_timeout' };
  } finally {
    clearTimeout(timer);
  }
}

export type PayPalVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies a webhook with PayPal's verify-webhook-signature API (their
 * recommended server-side check). Never trusts raw payload content before this.
 */
export async function verifyPayPalWebhook(
  env: Env,
  headers: Headers,
  rawBody: string,
  options: PayPalFetchOptions = {},
): Promise<PayPalVerifyResult> {
  const config = paypalConfig(env);
  if (!config.ok) return { ok: false, reason: config.reason };
  if (!config.webhookId) return { ok: false, reason: 'paypal_webhook_id_missing' };

  const token = await getAccessToken(env, config, options);
  if (!token) return { ok: false, reason: 'paypal_auth_failed' };

  const required = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  for (const name of required) {
    if (!headers.get(name)) return { ok: false, reason: `paypal_missing_header_${name}` };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(`${config.apiBase}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers.get('paypal-auth-algo'),
        cert_url: headers.get('paypal-cert-url'),
        transmission_id: headers.get('paypal-transmission-id'),
        transmission_sig: headers.get('paypal-transmission-sig'),
        transmission_time: headers.get('paypal-transmission-time'),
        webhook_id: config.webhookId,
        webhook_event: JSON.parse(rawBody),
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as { verification_status?: string } | null;
    if (data?.verification_status === 'SUCCESS') return { ok: true };
    return { ok: false, reason: 'paypal_signature_invalid' };
  } catch {
    return { ok: false, reason: 'paypal_timeout' };
  } finally {
    clearTimeout(timer);
  }
}

export interface PayPalEvent {
  id: string; // PayPal-Transmission-ID — idempotency key
  eventType: string;
  resource: Record<string, unknown>;
}

export function parsePayPalEvent(rawBody: string): PayPalEvent | null {
  try {
    const parsed = JSON.parse(rawBody) as { id?: unknown; event_type?: unknown; resource?: unknown };
    if (typeof parsed.id !== 'string' || typeof parsed.event_type !== 'string' || !parsed.resource || typeof parsed.resource !== 'object') {
      return null;
    }
    return { id: parsed.id, eventType: parsed.event_type, resource: parsed.resource as Record<string, unknown> };
  } catch {
    return null;
  }
}
