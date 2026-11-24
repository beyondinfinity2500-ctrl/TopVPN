/**
 * Renewal logic for TopVPN Premium.
 *
 * All purchases are one-time payments for a fixed access period. A renewal
 * extends the existing entitlement expiry by the plan interval. It never
 * creates an automatic subscription or recurring charge.
 *
 * Safety properties:
 *   - Expiry is always extended FROM the current expiry, never from now.
   *   A paid order can never be "un-paid" by a renewal attempt.
   *   Only the order's customer (verified by email) can renew.
   *   Webhook idempotency prevents double extension.
   */

import type { D1Database } from '@cloudflare/workers-types';
import { getPlan, isPlanId } from '../../src/lib/plans';
import { getVpnOrder, recordVpnOrderEvent, type VpnOrderRow } from './repo';
import { expiryDateFor } from '../provisioning';

export const RENEWAL_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RenewalOrder {
  id: string;
  plan_id: string;
  interval_months: number;
  amount_cents: number;
  currency: string;
  order_status: string;
  payment_status: string;
  provisioning_status: string;
  expire_at: string | null;
}

export interface RenewalEligibility {
  eligible: boolean;
  reason: 'eligible' | 'not_active' | 'no_expiry' | 'expired' | 'not_in_window';
  order: RenewalOrder;
  days_remaining: number | null;
  renewalPriceCents: number;
}

/**
 * Check if an order is eligible for renewal.
 *
 * Rules:
 *   - Order status must be 'active'
   *   - Payment status must be 'paid'
   *   - Provisioning status must be 'succeeded'
   *   - Expiry must exist and be within RENEWAL_WINDOW_DAYS
   */
export function checkRenewalEligibility(
  order: RenewalOrder,
  now: Date = new Date(),
): RenewalEligibility {
  // Renewal always costs the regular plan price — an intro/coupon discount is
  // a one-time first-purchase offer and never applies to renewals.
  const renewalPriceCents = isPlanId(order.plan_id) ? getPlan(order.plan_id).regularCents : order.amount_cents;

  if (
    order.order_status !== 'active' ||
    order.payment_status !== 'paid' ||
    order.provisioning_status !== 'succeeded'
  ) {
    return {
      eligible: false,
      reason: 'not_active',
      order,
      days_remaining: null,
      renewalPriceCents,
    };
  }

  if (!order.expire_at) {
    return { eligible: false, reason: 'no_expiry', order, days_remaining: null, renewalPriceCents };
  }

  const expireDate = new Date(order.expire_at + 'T00:00:00Z');
  const nowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const msRemaining = expireDate.getTime() - nowUtc.getTime();
  const secondsRemaining = msRemaining / 1000;

  if (secondsRemaining < 0) {
    return { eligible: false, reason: 'expired', order, days_remaining: null, renewalPriceCents };
  }

  if (msRemaining > RENEWAL_WINDOW_DAYS * MS_PER_DAY) {
    return {
      eligible: false,
      reason: 'not_in_window',
      order,
      days_remaining: Math.ceil(msRemaining / MS_PER_DAY),
      renewalPriceCents,
    };
  }

  return {
    eligible: true,
    reason: 'eligible',
    order,
    days_remaining: Math.ceil(msRemaining / MS_PER_DAY),
    renewalPriceCents,
  };
}

/**
 * Extend an existing paid order's expiry by the plan interval.
 *
 * Extends from the CURRENT expiry (not from now), so no paid time is lost.
 * Requires payment_status='paid', provisioning_status='succeeded', a non-null
 * expire_at, and order_status in ('active','expired').
 *
 * An expired order is accepted on purpose: a renewal checkout opened while the
 * order was active can be paid after the cron expired it. The customer paid for
 * a full period, so the row is brought back to active with the new date instead
 * of silently keeping the payment with no access.
 *
 * Returns true if the row was updated, false otherwise.
 */
export async function extendVpnExpiry(
  db: D1Database,
  orderId: string,
  now: string,
): Promise<boolean> {
  const order = await getVpnOrder(db, orderId);
  if (!order) return false;
  if (
    (order.order_status !== 'active' && order.order_status !== 'expired') ||
    order.payment_status !== 'paid' ||
    order.provisioning_status !== 'succeeded' ||
    !order.expire_at
  ) {
    return false;
  }

  const newExpireAt = expiryDateFor(order.expire_at, order.interval_months);
  const result = await db
    .prepare(
      `UPDATE vpn_orders
         SET order_status = 'active',
             subscription_status = 'active',
             expire_at = ?,
             updated_at = ?,
             version = version + 1
       WHERE id = ? AND order_status = ? AND payment_status = 'paid' AND provisioning_status = 'succeeded'`,
    )
    // Optimistic lock: order_status binds current status ('active' or 'expired')
    // to prevent lost updates if status changed concurrently.
    .bind(newExpireAt, now, order.id, order.order_status)
    .run();

  if ((result.meta?.changes ?? 0) === 1) {
    await recordVpnOrderEvent(db, {
      orderId: order.id,
      from: order.order_status,
      to: 'active',
      reason: 'renewal_extended',
      now,
    });
    return true;
  }
  return false;
}