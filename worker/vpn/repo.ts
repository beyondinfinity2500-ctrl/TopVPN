/**
 * D1 repository for the VPN domain. Every statement here touches only `vpn_*`
 * tables — it is structurally impossible for these helpers to read or write an
 * advertising order.
 */
import { claimProvisioning, type ProvisioningClaimResult } from '../provisioning';
import { assertTransition, type VpnOrderStatus, type VpnPaymentStatus, type VpnProvisioningStatus, type VpnSubscriptionStatus } from './state';

export interface VpnOrderRow {
  id: string;
  customer_email: string;
  customer_name: string | null;
  plan_id: string;
  interval_months: number;
  amount_cents: number;
  currency: string;
  order_status: VpnOrderStatus;
  payment_status: VpnPaymentStatus;
  provisioning_status: VpnProvisioningStatus;
  subscription_status: VpnSubscriptionStatus;
  provider_account_id: string | null;
  provider_username: string | null;
  expire_at: string | null;
  failure_reason: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  stripe_checkout_url: string | null;
  checkout_idempotency_key: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  provisioning_attempts: number;
}

export interface NewVpnOrder {
  id: string;
  customerEmail: string;
  customerName: string | null;
  planId: string;
  intervalMonths: number;
  amountCents: number;
  currency: string;
  providerUsername: string;
  idempotencyKey?: string | null;
  now: string;
}

export interface VpnAccountRow {
  order_id: string;
  provider_account_id: string;
  username: string;
  expire_at: string | null;
  created_at: string;
  updated_at: string;
}

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

export async function insertVpnOrder(db: D1Database, order: NewVpnOrder): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vpn_orders
         (id, customer_email, customer_name, plan_id, interval_months, amount_cents, currency,
          provider_username, checkout_idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      order.id,
      order.customerEmail,
      order.customerName,
      order.planId,
      order.intervalMonths,
      order.amountCents,
      order.currency,
      order.providerUsername,
      order.idempotencyKey ?? null,
      order.now,
      order.now,
    )
    .run();
}

export async function getVpnOrder(db: D1Database, id: string): Promise<VpnOrderRow | null> {
  return db.prepare(`SELECT * FROM vpn_orders WHERE id = ?`).bind(id).first<VpnOrderRow>();
}

export async function getVpnOrderBySession(db: D1Database, sessionId: string): Promise<VpnOrderRow | null> {
  return db
    .prepare(`SELECT * FROM vpn_orders WHERE stripe_session_id = ?`)
    .bind(sessionId)
    .first<VpnOrderRow>();
}

/** Used to resolve refund events that only carry the PaymentIntent id. */
export async function getVpnOrderByPaymentIntent(
  db: D1Database,
  paymentIntent: string,
): Promise<VpnOrderRow | null> {
  return db
    .prepare(`SELECT * FROM vpn_orders WHERE stripe_payment_intent = ?`)
    .bind(paymentIntent)
    .first<VpnOrderRow>();
}

export async function getVpnOrderByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<VpnOrderRow | null> {
  return db
    .prepare(`SELECT * FROM vpn_orders WHERE checkout_idempotency_key = ?`)
    .bind(key)
    .first<VpnOrderRow>();
}

/** Stores the Stripe session id/url once, so a retried request reuses it. */
export async function attachVpnCheckoutSession(
  db: D1Database,
  id: string,
  sessionId: string,
  checkoutUrl: string,
  now: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE vpn_orders
          SET stripe_session_id = ?, stripe_checkout_url = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND stripe_session_id IS NULL`,
    )
    .bind(sessionId, checkoutUrl, now, id)
    .run();
  return changes(result) === 1;
}

/** Cancels an unpaid order when checkout creation failed (no money involved). */
export async function cancelVpnOrder(db: D1Database, id: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE vpn_orders SET order_status = 'cancelled', updated_at = ?, version = version + 1
        WHERE id = ? AND order_status = 'pending_payment' AND payment_status = 'unpaid'`,
    )
    .bind(now, id)
    .run();
  return changes(result) === 1;
}

/**
 * Marks an unpaid order paid. The WHERE clause makes this the only place a
 * payment can be accepted, and makes a duplicate/replayed event a no-op.
 * Returns true only for the request that actually changed the row.
 */
export async function markVpnPaid(
  db: D1Database,
  id: string,
  details: { sessionId?: string | null; paymentIntent?: string | null; now: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE vpn_orders
          SET order_status = 'paid',
              payment_status = 'paid',
              paid_at = ?,
              updated_at = ?,
              stripe_session_id = COALESCE(?, stripe_session_id),
              stripe_payment_intent = COALESCE(?, stripe_payment_intent),
              version = version + 1
        WHERE id = ? AND order_status = 'pending_payment' AND payment_status = 'unpaid'`,
    )
    .bind(details.now, details.now, details.sessionId ?? null, details.paymentIntent ?? null, id)
    .run();
  return changes(result) === 1;
}

/**
 * Records a refund even if it arrives before the paid event (Stripe does not
 * guarantee ordering). A pending order becomes `cancelled`; a paid/provisioned
 * order becomes `refunded`. Either way `payment_status` becomes `refunded`, so a
 * delayed paid event can never revive it. Deliberately does NOT touch the
 * provider account (business rule unverified).
 */
export async function markVpnRefunded(db: D1Database, id: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE vpn_orders
          SET payment_status = 'refunded',
              order_status = CASE WHEN order_status = 'pending_payment' THEN 'cancelled' ELSE 'refunded' END,
              subscription_status = CASE WHEN order_status = 'pending_payment' THEN subscription_status ELSE 'cancelled' END,
              updated_at = ?,
              version = version + 1
        WHERE id = ? AND payment_status IN ('unpaid','paid')`,
    )
    .bind(now, id)
    .run();
  const changed = changes(result) === 1;
  if (changed) {
    const order = await getVpnOrder(db, id);
    await recordVpnOrderEvent(db, {
      orderId: id,
      from: null,
      to: order?.order_status ?? 'refunded',
      reason: order?.order_status === 'cancelled' ? 'refund_before_payment' : 'refund_recorded',
      now,
    });
  }
  return changed;
}

export interface VpnOrderPatch {
  paymentStatus?: VpnPaymentStatus;
  provisioningStatus?: VpnProvisioningStatus;
  subscriptionStatus?: VpnSubscriptionStatus;
  providerAccountId?: string;
  expireAt?: string | null;
  failureReason?: string | null;
  stripeSessionId?: string;
  stripePaymentIntent?: string;
}

/**
 * Optimistic transition: only succeeds when the row is still in `from`.
 * Returns false when another request already moved it (safe no-op).
 */
export async function transitionVpnOrder(
  db: D1Database,
  id: string,
  from: VpnOrderStatus,
  to: VpnOrderStatus,
  patch: VpnOrderPatch,
  reason: string | null,
  now: string,
): Promise<boolean> {
  assertTransition(from, to);
  const sets: string[] = ['order_status = ?', 'updated_at = ?', 'version = version + 1'];
  const values: unknown[] = [to, now];

  if (patch.paymentStatus !== undefined) {
    sets.push('payment_status = ?');
    values.push(patch.paymentStatus);
  }
  if (patch.provisioningStatus !== undefined) {
    sets.push('provisioning_status = ?');
    values.push(patch.provisioningStatus);
  }
  if (patch.subscriptionStatus !== undefined) {
    sets.push('subscription_status = ?');
    values.push(patch.subscriptionStatus);
  }
  if (patch.providerAccountId !== undefined) {
    sets.push('provider_account_id = ?');
    values.push(patch.providerAccountId);
  }
  if (patch.expireAt !== undefined) {
    sets.push('expire_at = ?');
    values.push(patch.expireAt);
  }
  if (patch.failureReason !== undefined) {
    sets.push('failure_reason = ?');
    values.push(patch.failureReason);
  }
  if (patch.stripeSessionId !== undefined) {
    sets.push('stripe_session_id = ?');
    values.push(patch.stripeSessionId);
  }
  if (patch.stripePaymentIntent !== undefined) {
    sets.push('stripe_payment_intent = ?');
    values.push(patch.stripePaymentIntent);
  }

  const result = await db
    .prepare(`UPDATE vpn_orders SET ${sets.join(', ')} WHERE id = ? AND order_status = ?`)
    .bind(...values, id, from)
    .run();
  const changed = changes(result) === 1;

  if (changed) await recordVpnOrderEvent(db, { orderId: id, from, to, reason, now });
  return changed;
}

export async function recordVpnOrderEvent(
  db: D1Database,
  event: { orderId: string; from: VpnOrderStatus | null; to: VpnOrderStatus | string; reason: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vpn_order_events (order_id, from_status, to_status, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(event.orderId, event.from, event.to, event.reason, event.now)
    .run();
}

/** Atomic provisioning gate (one row per order). See worker/provisioning.ts. */
export async function claimVpnProvisioning(
  db: D1Database,
  orderId: string,
  now: string,
): Promise<ProvisioningClaimResult> {
  return claimProvisioning(db, orderId, now);
}

/**
 * Persists the provider account mapping. ON CONFLICT(order_id) DO NOTHING makes
 * a retry a no-op instead of overwriting a different provider account.
 */
export async function saveVpnAccount(
  db: D1Database,
  account: { orderId: string; providerAccountId: string; username: string; expireAt: string | null; now: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO vpn_accounts (order_id, provider_account_id, username, expire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .bind(account.orderId, account.providerAccountId, account.username, account.expireAt, account.now, account.now)
    .run();
  return changes(result) === 1;
}

export async function getVpnAccount(db: D1Database, orderId: string): Promise<VpnAccountRow | null> {
  return db.prepare(`SELECT * FROM vpn_accounts WHERE order_id = ?`).bind(orderId).first<VpnAccountRow>();
}

/* ---------- payment event idempotency ---------- */

export async function recordVpnPaymentEvent(
  db: D1Database,
  event: { eventId: string; orderId: string; eventType: string; amountCents: number | null; currency: string | null; now: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO vpn_payment_events (event_id, order_id, event_type, amount_cents, currency, received_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .bind(event.eventId, event.orderId, event.eventType, event.amountCents, event.currency, event.now)
    .run();

  if (changes(result) === 1) return true;

  // A row that exists but was never processed means a previous attempt crashed
  // between insert and completion. Allow the retry to process it again; the
  // guarded payment/refund updates and the provisioning claim keep replay safe.
  const existing = await db
    .prepare(`SELECT processed_at FROM vpn_payment_events WHERE event_id = ?`)
    .bind(event.eventId)
    .first<{ processed_at: string | null }>();
  return existing ? existing.processed_at === null : false;
}

export async function markVpnPaymentEventProcessed(db: D1Database, eventId: string, now: string): Promise<void> {
  await db
    .prepare(`UPDATE vpn_payment_events SET processed_at = ? WHERE event_id = ?`)
    .bind(now, eventId)
    .run();
}

/** Removes an unprocessed event so a Stripe retry can process it again. */
export async function releaseVpnPaymentEvent(db: D1Database, eventId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM vpn_payment_events WHERE event_id = ? AND processed_at IS NULL`)
    .bind(eventId)
    .run();
}

/**
 * Records a non-terminal Stripe failure (async payment failed / refund failed)
 * without changing the order, payment, refund or provisioning state.
 */
export async function setVpnFailureNote(
  db: D1Database,
  order: { id: string; order_status: VpnOrderStatus },
  reason: string,
  now: string,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE vpn_orders SET failure_reason = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND order_status NOT IN ('active','expired','cancelled','refunded')`,
    )
    .bind(reason, now, order.id)
    .run();
  if (changes(result) !== 1) return;
  await recordVpnOrderEvent(db, {
    orderId: order.id,
    from: order.order_status,
    to: order.order_status,
    reason,
    now,
  });
}

/** Releases a claim only when no provider call can have succeeded (see service). */
export async function releaseVpnProvisioningClaim(db: D1Database, orderId: string): Promise<void> {
  await db.prepare(`DELETE FROM vpn_provisioning_claims WHERE order_id = ?`).bind(orderId).run();
}

/** Used to decide first-month intro eligibility from trusted server state. */
export async function hasPriorPaidVpnOrder(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS found FROM vpn_orders WHERE lower(customer_email) = lower(?) AND payment_status = 'paid' LIMIT 1`)
    .bind(email)
    .first<{ found: number }>();
  return !!row;
}

/* ---------- recovery helpers ---------- */

export interface RecoverableOrderRow {
  id: string;
  plan_id: string;
  order_status: VpnOrderStatus;
  payment_status: VpnPaymentStatus;
  provisioning_status: VpnProvisioningStatus;
  failure_reason: string | null;
  updated_at: string;
}

export async function countVpnProvisioningAttempts(db: D1Database, orderId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT provisioning_attempts FROM vpn_orders WHERE id = ?`)
    .bind(orderId)
    .first<{ provisioning_attempts: number }>();
  return row?.provisioning_attempts ?? 0;
}

/** Counts every attempt that reaches the provider call (durable column). */
export async function incrementVpnProvisioningAttempts(db: D1Database, orderId: string): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE vpn_orders SET provisioning_attempts = provisioning_attempts + 1 WHERE id = ? RETURNING provisioning_attempts`,
    )
    .bind(orderId)
    .first<{ provisioning_attempts: number }>();
  return row?.provisioning_attempts ?? 0;
}

export async function listRecoverableVpnOrders(db: D1Database, limit = 50): Promise<RecoverableOrderRow[]> {
  const result = await db
    .prepare(
      `SELECT id, plan_id, order_status, payment_status, provisioning_status, failure_reason, updated_at
         FROM vpn_orders
        WHERE order_status IN ('paid','provisioning','provisioning_failed','reconciliation_required')
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<RecoverableOrderRow>();
  return result.results ?? [];
}
