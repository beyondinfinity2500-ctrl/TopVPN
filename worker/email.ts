/**
 * Email delivery via Resend (https://resend.com). Requires RESEND_API_KEY and a
 * verified sending domain (EMAIL_FROM). If the provider is not configured, we
 * record that fact on the order and never pretend a message was delivered.
 */
import type { Env } from './env';
import { adminEmail, emailFrom } from './env';
import type { AdsOrder } from './db';
import { CURRENCY, PLACEMENT_LABELS } from '../src/lib/ads/pricing';

export interface SendResult {
  ok: boolean;
  /** sent | failed:<detail> | not_configured */
  status: string;
}

const RESEND_API = 'https://api.resend.com/emails';

function amountLabel(order: AdsOrder): string {
  return `${(order.amount_cents / 100).toFixed(2)} ${order.currency}`;
}

export async function sendEmail(
  env: Env,
  to: string[],
  subject: string,
  html: string,
): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { ok: false, status: 'not_configured' };
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: emailFrom(env), to, subject, html }),
    });
    if (res.ok) return { ok: true, status: 'sent' };
    const text = await res.text().catch(() => '');
    return { ok: false, status: `failed:http_${res.status}${text ? `:${text.slice(0, 120)}` : ''}` };
  } catch (err) {
    return { ok: false, status: `failed:${err instanceof Error ? err.message : 'network error'}` };
  }
}

export function customerConfirmationHtml(order: AdsOrder, paymentNote: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2933">
  <h1 style="font-size:20px">Thank you for your advertising order</h1>
  <p>We have received your order and will review your creative before it goes live.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:6px 0;color:#667085">Order ID</td><td style="padding:6px 0;font-weight:600">${order.id}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Placement</td><td style="padding:6px 0">${PLACEMENT_LABELS[order.placement]}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Duration</td><td style="padding:6px 0">${order.duration_months} month${order.duration_months > 1 ? 's' : ''}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Creative format</td><td style="padding:6px 0">${order.creative_format === 'text' ? 'Text' : 'Image'}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Total</td><td style="padding:6px 0;font-weight:600">${amountLabel(order)} ${CURRENCY === 'USD' ? 'USD' : ''}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Payment status</td><td style="padding:6px 0">${paymentNote}</td></tr>
  </table>
  <p style="background:#f2f4f7;border-left:3px solid #475467;padding:12px 16px;font-size:14px">
    Your campaign is subject to advertising approval. Payment does not guarantee
    that a creative will be published; submitted ads must comply with our site
    policies. We will notify you once your creative is reviewed.
  </p>
  <p style="color:#667085;font-size:13px">TopVPN — https://www.topvpn.top</p>
</div>`;
}

export function adminNotificationHtml(order: AdsOrder, subject: string, paymentNote: string): string {
  const creative =
    order.creative_format === 'text'
      ? `<p style="font-family:monospace;background:#f2f4f7;padding:10px">${(order.ad_copy ?? '').replace(/</g, '&lt;')}</p>`
      : `<p>Image creative stored in R2 key: <code>${order.creative_r2_key ?? '—'}</code></p>`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2933">
  <h1 style="font-size:18px">${subject}</h1>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:6px 0;color:#667085">Order ID</td><td style="padding:6px 0;font-weight:600">${order.id}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Customer</td><td style="padding:6px 0">${order.customer_name}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Email</td><td style="padding:6px 0">${order.customer_email}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Website</td><td style="padding:6px 0">${order.customer_website}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Placement</td><td style="padding:6px 0">${PLACEMENT_LABELS[order.placement]} · ${order.duration_months} month${order.duration_months > 1 ? 's' : ''}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Amount</td><td style="padding:6px 0;font-weight:600">${amountLabel(order)}</td></tr>
    <tr><td style="padding:6px 0;color:#667085">Payment</td><td style="padding:6px 0">${paymentNote}</td></tr>
  </table>
  <h2 style="font-size:15px">Creative (${order.creative_format})</h2>
  ${creative}
  <p><a href="https://www.topvpn.top/admin">Review in the admin dashboard</a></p>
</div>`;
}

/** Sends the order confirmation to the customer and a notification to the admin. */
export async function sendOrderEmails(
  env: Env,
  order: AdsOrder,
  paymentNote: string,
): Promise<{ customer: SendResult; admin: SendResult }> {
  const [customer, admin] = await Promise.all([
    sendEmail(
      env,
      [order.customer_email],
      `Your TopVPN advertising order ${order.id}`,
      customerConfirmationHtml(order, paymentNote),
    ),
    sendEmail(
      env,
      [adminEmail(env)],
      `New advertising order ${order.id} — ${PLACEMENT_LABELS[order.placement]}`,
      adminNotificationHtml(order, `New advertising order received`, paymentNote),
    ),
  ]);
  return { customer, admin };
}

export async function sendPaymentStatusEmail(
  env: Env,
  order: AdsOrder,
  paymentNote: string,
): Promise<SendResult> {
  return sendEmail(
    env,
    [order.customer_email],
    `Payment update for TopVPN advertising order ${order.id}`,
    customerConfirmationHtml(order, paymentNote),
  );
}

export async function sendAdminPaymentEmail(env: Env, order: AdsOrder, paymentNote: string): Promise<SendResult> {
  return sendEmail(
    env,
    [adminEmail(env)],
    `Payment status changed for order ${order.id}`,
    adminNotificationHtml(order, `Payment status changed — ${order.payment_status}`, paymentNote),
  );
}
