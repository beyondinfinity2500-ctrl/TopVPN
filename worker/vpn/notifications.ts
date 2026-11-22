/**
 * Customer-facing notifications for the VPN domain.
 *
 * All sends are gated on RESEND_API_KEY and never block the calling operation:
 * a failed send is recorded as an order event and retried on the next run.
 */
import type { Env } from '../env';
import { sendEmail } from '../email';
import { customerEmailFrom } from '../env';
import { getVpnOrder } from './repo';

export async function sendVpnExpiryWarning(env: Env, orderId: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const order = await getVpnOrder(env.DB, orderId);
  if (!order || order.order_status !== 'active' || !order.expire_at) return;

  const to = [order.customer_email];
  const subject = 'Your TopVPN subscription expires soon';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2933">
    <h1 style="font-size:20px">Your TopVPN subscription expires on ${order.expire_at}</h1>
    <p>Renew before the expiry date to keep your VPN access uninterrupted.</p>
    <p style="margin-top:16px"><a href="${(env.SITE_URL || 'https://www.topvpn.top')}/account">Manage your subscription</a></p>
    <p style="color:#667085;font-size:13px;margin-top:24px">Order ${order.id} · ${order.plan_id} plan</p>
  </div>`;

  const result = await sendEmail(env, to, subject, html, customerEmailFrom(env));
  await env.DB.prepare(
    `INSERT INTO vpn_order_events (order_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(order.id, order.order_status, order.order_status, `expiry_warning_${result.status}`, new Date().toISOString())
    .run();
}

/**
 * Send warnings for active orders expiring within `days` days, at most once
 * per order per 6-day window (checked via vpn_order_events).
 */
export async function sendPendingExpiryWarnings(env: Env, days = 7): Promise<number> {
  if (!env.RESEND_API_KEY) return 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const rows = await env.DB.prepare(
    `SELECT id FROM vpn_orders
       WHERE order_status = 'active'
         AND expire_at IS NOT NULL
         AND expire_at >= ?
         AND expire_at <= ?`,
  )
    .bind(today, cutoff)
    .all<{ id: string }>();

  let sent = 0;
  for (const row of rows.results ?? []) {
    const recent = await env.DB.prepare(
      `SELECT 1 AS found FROM vpn_order_events
         WHERE order_id = ? AND reason LIKE 'expiry_warning_%'
           AND created_at >= datetime('now', '-6 days') LIMIT 1`,
    )
      .bind(row.id)
      .first<{ found: number }>();
    if (recent) continue;
    await sendVpnExpiryWarning(env, row.id);
    sent++;
  }
  return sent;
}