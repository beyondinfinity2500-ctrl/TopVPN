/**
 * Stripe integration without the Node SDK: the Worker runtime provides fetch
 * and WebCrypto, which is all the REST API and webhook signing need. This keeps
 * the worker free of the SDK's Node polyfills.
 *
 * Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (see docs/ADVERTISING_SETUP.md).
 */
import type { Env } from './env';
import { cryptoEnabled, siteUrl } from './env';
import {
  CURRENCY,
  PLACEMENT_LABELS,
  type Placement,
  type Duration,
} from '../src/lib/ads/pricing';
import type { AdsOrder } from './db';

const STRIPE_API = 'https://api.stripe.com/v1';
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const enc = new TextEncoder();

function formEncode(params: Record<string, string | number>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

export interface CheckoutSessionResult {
  id?: string;
  url?: string;
  error?: string;
}

/**
 * Builds the form-encoded body and payment method types for a Checkout Session.
 * Pure function (no network) so the trusted amount and metadata are unit-tested.
 * The amount comes from the server-calculated order row, never from the client.
 */
export function checkoutSessionParams(env: Env, order: AdsOrder): { body: string; paymentMethodTypes: string[] } {
  const name = `TopVPN Advertising — ${PLACEMENT_LABELS[order.placement]} · ${order.duration_months} month${order.duration_months > 1 ? 's' : ''}`;
  const paymentMethodTypes = cryptoEnabled(env) ? ['card', 'crypto'] : ['card'];
  const params: Record<string, string | number> = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': CURRENCY.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(order.amount_cents),
    'line_items[0][price_data][product_data][name]': name,
    'metadata[order_id]': order.id,
    client_reference_id: order.id,
    success_url: `${siteUrl(env)}/advertise?order=${encodeURIComponent(order.id)}&status=success`,
    cancel_url: `${siteUrl(env)}/advertise?order=${encodeURIComponent(order.id)}&status=cancelled`,
  };
  paymentMethodTypes.forEach((type, i) => {
    params[`payment_method_types[${i}]`] = type;
  });
  return { body: formEncode(params), paymentMethodTypes };
}

export async function createCheckoutSession(env: Env, order: AdsOrder): Promise<CheckoutSessionResult> {
  if (!env.STRIPE_SECRET_KEY) return { error: 'Stripe is not configured (missing secret key).' };
  const { body } = checkoutSessionParams(env, order);

  try {
    const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !json.id || !json.url) {
      return { error: json.error?.message || `Stripe API returned HTTP ${res.status}` };
    }
    return { id: json.id, url: json.url };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Stripe request failed.' };
  }
}

/* ---------- Webhook signature verification (Stripe signing scheme) ---------- */
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  const parts = header.split(',');
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!Number.isInteger(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function timingSafeHexCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Verifies the `stripe-signature` header against the raw request body using
 * HMAC-SHA256 with the webhook secret. Rejects stale timestamps (replay
 * protection) and requires a constant-time signature match.
 */
export async function verifyWebhookSignature(args: {
  secret: string;
  rawBody: string;
  signatureHeader: string;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const { secret, rawBody, signatureHeader } = args;
  const tolerance = args.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) return false;

  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signed = `${parsed.timestamp}.${rawBody}`;
  const expectedHex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signed)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return parsed.signatures.some((sig) => timingSafeHexCompare(sig, expectedHex));
}

/* ---------- Minimal webhook event typing ---------- */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export function parseWebhookEvent(rawBody: string): StripeEvent | null {
  try {
    const event = JSON.parse(rawBody) as StripeEvent;
    if (typeof event.id !== 'string' || typeof event.type !== 'string') return null;
    return event;
  } catch {
    return null;
  }
}

export interface CheckoutSessionObject {
  id: string;
  payment_status?: string;
  payment_intent?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export function asCheckoutSession(obj: Record<string, unknown>): CheckoutSessionObject | null {
  if (typeof obj.id !== 'string') return null;
  return obj as unknown as CheckoutSessionObject;
}

export function placementLabelFor(order: { placement: Placement; duration_months: Duration }): string {
  return `${PLACEMENT_LABELS[order.placement]} · ${order.duration_months} month${order.duration_months > 1 ? 's' : ''}`;
}
