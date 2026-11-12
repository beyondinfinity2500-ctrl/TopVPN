/**
 * Coupon service for VPN orders. Server-side only — the browser may submit a
 * coupon CODE, never a discount amount. All prices derive from src/lib/plans.ts.
 *
 * The $9 -> $3 first-month offer is coupon FIRST-MONTH (fixed $6 off the
 * monthly plan, first purchase only). Annual and two-year prices are untouched.
 *
 * Concurrency: redemption is an atomic INSERT protected by
 * UNIQUE(coupon_id, customer_email) and UNIQUE(order_id), so the same customer
 * can never redeem the same coupon twice, even with parallel checkout requests.
 */
import { getPlan, isPlanId, type PlanId } from '../../src/lib/plans';

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'fixed' | 'percent';
  discount_value: number;
  applies_plan_id: PlanId | null;
  first_purchase_only: number;
  starts_at: string | null;
  expires_at: string | null;
  max_redemptions: number | null;
  per_customer_limit: number;
  active: number;
  created_at: string;
}

export interface CouponPricing {
  originalCents: number;
  discountCents: number;
  finalCents: number;
  coupon: CouponRow;
}

export type CouponCheck =
  | { ok: true; pricing: CouponPricing }
  | { ok: false; reason: string };

export async function findCouponByCode(db: D1Database, code: string): Promise<CouponRow | null> {
  return db
    .prepare(`SELECT * FROM vpn_coupons WHERE code = ?`)
    .bind(code.trim().toUpperCase())
    .first<CouponRow>();
}

/** Price math only — no eligibility. Exported for tests. */
export function computeDiscountedCents(planId: PlanId, coupon: CouponRow): CouponPricing {
  const plan = getPlan(planId);
  const original = plan.regularCents;
  let discount: number;
  if (coupon.discount_type === 'percent') {
    discount = Math.round((original * coupon.discount_value) / 100);
  } else {
    discount = coupon.discount_value;
  }
  if (discount < 0) discount = 0;
  if (discount > original) discount = original; // final price never goes below zero
  return { originalCents: original, discountCents: discount, finalCents: original - discount, coupon };
}

/**
 * Full server-side eligibility check: active, time window, plan, global and
 * per-customer redemption limits, and first-purchase-only (no prior PAID order
 * for this email — pending/cancelled/expired orders never grant eligibility).
 */
export async function checkCouponEligibility(
  db: D1Database,
  coupon: CouponRow,
  planId: PlanId,
  emailNorm: string,
  nowIso: string,
): Promise<{ ok: true; pricing: CouponPricing } | { ok: false; reason: string }> {
  if (!coupon.active) return { ok: false, reason: 'This coupon is not active.' };
  if (coupon.starts_at && nowIso < coupon.starts_at) {
    return { ok: false, reason: 'This coupon is not active yet.' };
  }
  if (coupon.expires_at && nowIso > coupon.expires_at) {
    return { ok: false, reason: 'This coupon has expired.' };
  }
  if (coupon.applies_plan_id && coupon.applies_plan_id !== planId) {
    return { ok: false, reason: 'This coupon does not apply to the selected plan.' };
  }

  if (coupon.max_redemptions !== null) {
    const total = await db
      .prepare(`SELECT COUNT(*) AS n FROM vpn_coupon_redemptions WHERE coupon_id = ?`)
      .bind(coupon.id)
      .first<{ n: number }>();
    if ((total?.n ?? 0) >= coupon.max_redemptions) {
      return { ok: false, reason: 'This coupon has reached its redemption limit.' };
    }
  }

  const perCustomer = await db
    .prepare(`SELECT COUNT(*) AS n FROM vpn_coupon_redemptions WHERE coupon_id = ? AND customer_email = ?`)
    .bind(coupon.id, emailNorm)
    .first<{ n: number }>();
  if ((perCustomer?.n ?? 0) >= Math.max(1, coupon.per_customer_limit)) {
    return { ok: false, reason: 'You have already used this coupon.' };
  }

  if (coupon.first_purchase_only) {
    const paid = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM vpn_orders
          WHERE lower(trim(customer_email)) = ? AND payment_status = 'paid'`,
      )
      .bind(emailNorm)
      .first<{ n: number }>();
    if ((paid?.n ?? 0) > 0) {
      return { ok: false, reason: 'This discount is only available on your first purchase.' };
    }
  }

  return { ok: true, pricing: computeDiscountedCents(planId, coupon) };
}

/** Validate a submitted code end-to-end. Never trust client amounts. */
export async function validateCouponForOrder(
  db: D1Database,
  code: string,
  planId: PlanId,
  email: string,
  nowIso: string,
): Promise<CouponCheck> {
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 40) return { ok: false, reason: 'Invalid coupon code.' };
  if (!isPlanId(planId)) return { ok: false, reason: 'Unknown plan.' };
  const coupon = await findCouponByCode(db, trimmed);
  if (!coupon) return { ok: false, reason: 'Coupon code not recognized.' };
  return checkCouponEligibility(db, coupon, planId, email.toLowerCase().trim(), nowIso);
}

/**
 * Atomically consume one redemption slot. Returns false when a concurrent
 * request already redeemed this coupon for this customer/order.
 */
export async function recordCouponRedemption(
  db: D1Database,
  couponId: string,
  orderId: string,
  emailNorm: string,
  nowIso: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO vpn_coupon_redemptions (coupon_id, customer_email, order_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(couponId, emailNorm, orderId, nowIso)
    .run();
  const meta = result.meta as { changes?: number } | undefined;
  return (meta?.changes ?? 0) > 0;
}

/** Frees the slot when its checkout session is expired/cancelled and never paid. */
export async function releaseCouponRedemption(db: D1Database, orderId: string): Promise<void> {
  await db.prepare(`DELETE FROM vpn_coupon_redemptions WHERE order_id = ?`).bind(orderId).run();
}

/** Applies coupon columns to a pending order (amount must be re-derived server-side). */
export async function attachCouponToOrder(
  db: D1Database,
  orderId: string,
  pricing: CouponPricing,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE vpn_orders
          SET amount_cents = ?, original_amount_cents = ?, discount_cents = ?,
              coupon_id = ?, updated_at = ?
        WHERE id = ? AND order_status = 'pending_payment' AND payment_status = 'unpaid'`,
    )
    .bind(pricing.finalCents, pricing.originalCents, pricing.discountCents, pricing.coupon.id, nowIso, orderId)
    .run();
}

/* ---------- admin coupon management ---------- */

export interface NewCouponInput {
  code: string;
  description?: string | null;
  discountType: 'fixed' | 'percent';
  discountValue: number;
  appliesPlanId?: PlanId | null;
  firstPurchaseOnly?: boolean;
  startsAt?: string | null;
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  perCustomerLimit?: number;
}

export async function createCoupon(db: D1Database, input: NewCouponInput, nowIso: string): Promise<CouponRow> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new Error('Coupon code must be 3-40 chars (A-Z 0-9 _ -).');
  if (input.discountValue <= 0) throw new Error('Discount value must be positive.');
  if (input.discountType === 'percent' && input.discountValue > 100) {
    throw new Error('Percent discount cannot exceed 100.');
  }
  const id = `cpn-${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO vpn_coupons
         (id, code, description, discount_type, discount_value, applies_plan_id,
          first_purchase_only, starts_at, expires_at, max_redemptions, per_customer_limit,
          active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      id,
      code,
      input.description ?? null,
      input.discountType,
      input.discountValue,
      input.appliesPlanId ?? null,
      input.firstPurchaseOnly ? 1 : 0,
      input.startsAt ?? null,
      input.expiresAt ?? null,
      input.maxRedemptions ?? null,
      Math.max(1, input.perCustomerLimit ?? 1),
      nowIso,
    )
    .run();
  const row = await db.prepare(`SELECT * FROM vpn_coupons WHERE id = ?`).bind(id).first<CouponRow>();
  if (!row) throw new Error('createCoupon: insert failed');
  return row;
}

export async function listCoupons(db: D1Database): Promise<(CouponRow & { redemptions: number })[]> {
  const result = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM vpn_coupon_redemptions r WHERE r.coupon_id = c.id) AS redemptions
         FROM vpn_coupons c ORDER BY c.created_at DESC`,
    )
    .all<CouponRow & { redemptions: number }>();
  return result.results ?? [];
}

export async function setCouponActive(db: D1Database, couponId: string, active: boolean): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE vpn_coupons SET active = ? WHERE id = ?`)
    .bind(active ? 1 : 0, couponId)
    .run();
  const meta = result.meta as { changes?: number } | undefined;
  return (meta?.changes ?? 0) > 0;
}
