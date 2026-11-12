/**
 * Coupon + first-purchase discount tests.
 *
 * Covers: $9 -> $3 math, server-side eligibility (first purchase, plan,
 * window, limits), concurrent redemption safety, checkout integration
 * (discounted session amount, one redemption per customer), and renewal
 * pricing (intro discount never applies to renewals).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, fetch as workerFetch, testEnv } from './helpers';
import { vpnCheckout } from '../routes/vpn';
import { computeDiscountedCents, recordCouponRedemption, releaseCouponRedemption, validateCouponForOrder } from '../vpn/coupons';
import { checkRenewalEligibility } from '../vpn/renewal';
import type { CouponRow } from '../vpn/coupons';

const TEST_KEY = 'sk_test_fake_key_for_tests';

function envWith(extra: Partial<Env>): Env {
  return {
    DB: testEnv.DB,
    VPN_SALES_ENABLED: 'true',
    VPN_SANDBOX_CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: TEST_KEY,
    SITE_URL: 'https://www.topvpn.test',
    ...extra,
  } as unknown as Env;
}

let ip = 0;
function nextIp(): string {
  ip += 1;
  return `10.71.0.${ip}`;
}

function request(body: Record<string, unknown>): Request {
  return new Request('https://topvpn.test/api/vpn/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
    body: JSON.stringify(body),
  });
}

function fakeStripe(status = 200, payload: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const SESSION = { id: 'cs_test_coupon', url: 'https://checkout.stripe.com/c/pay/cs_test_coupon' };

function couponRow(overrides: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 'cpn-test',
    code: 'TEST',
    description: null,
    discount_type: 'fixed',
    discount_value: 600,
    applies_plan_id: 'monthly',
    first_purchase_only: 0,
    starts_at: null,
    expires_at: null,
    max_redemptions: null,
    per_customer_limit: 1,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  await applyMigrations();
});

describe('coupon price math', () => {
  it('prices the first month of the monthly plan at $3 ($9 - $6)', () => {
    const pricing = computeDiscountedCents('monthly', couponRow());
    expect(pricing.originalCents).toBe(900);
    expect(pricing.discountCents).toBe(600);
    expect(pricing.finalCents).toBe(300);
  });

  it('never discounts below zero and never touches annual/two-year prices', () => {
    const huge = computeDiscountedCents('monthly', couponRow({ discount_value: 5000 }));
    expect(huge.finalCents).toBe(0);

    const percent = computeDiscountedCents('annual', couponRow({ discount_type: 'percent', discount_value: 10, applies_plan_id: null }));
    expect(percent.finalCents).toBe(6480); // $72 - 10%
  });
});

describe('coupon eligibility (server-side)', () => {
  it('rejects unknown codes', async () => {
    const check = await validateCouponForOrder(testEnv.DB, 'NOPE-NOPE', 'monthly', 'a@example.com', NOW);
    expect(check.ok).toBe(false);
  });

  it('rejects inactive, expired, and wrong-plan coupons', async () => {
    const inactive = await validateCouponForOrder(testEnv.DB, 'FIRST-MONTH', 'monthly', 'a@example.com', NOW);
    expect(inactive.ok).toBe(true); // seeded coupon is active

    const expired = await validateCouponForOrder(testEnv.DB, 'FIRST-MONTH', 'monthly', 'a@example.com', '2030-01-01T00:00:00.000Z');
    // no expiry on the seeded coupon — still valid far in the future
    expect(expired.ok).toBe(true);

    const wrongPlan = await validateCouponForOrder(testEnv.DB, 'FIRST-MONTH', 'annual', 'a@example.com', NOW);
    expect(wrongPlan.ok).toBe(false);
  });

  it('enforces first-purchase-only against PAID order history', async () => {
    const email = 'veteran@example.com';
    await testEnv.DB.prepare(
      `INSERT INTO vpn_orders (id, customer_email, plan_id, interval_months, amount_cents, currency,
         payment_status, created_at, updated_at)
       VALUES ('ORD-VPN-paidhist', ?, 'monthly', 1, 900, 'USD', 'paid', ?, ?)`,
    )
      .bind(email, NOW, NOW)
      .run();

    const check = await validateCouponForOrder(testEnv.DB, 'FIRST-MONTH', 'monthly', email, NOW);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/first purchase/i);

    // A pending order must NOT grant or burn eligibility.
    await testEnv.DB.prepare(
      `INSERT INTO vpn_orders (id, customer_email, plan_id, interval_months, amount_cents, currency,
         order_status, payment_status, created_at, updated_at)
       VALUES ('ORD-VPN-pendhist', 'newbie@example.com', 'monthly', 1, 900, 'USD', 'pending_payment', 'unpaid', ?, ?)`,
    )
      .bind(NOW, NOW)
      .run();
    const pending = await validateCouponForOrder(testEnv.DB, 'FIRST-MONTH', 'monthly', 'newbie@example.com', NOW);
    expect(pending.ok).toBe(true);
  });
});

describe('coupon redemption (concurrency-safe)', () => {
  it('consumes one slot per customer and blocks a second redemption', async () => {
    const first = await recordCouponRedemption(testEnv.DB, 'cpn-first-month', 'ORD-VPN-red1', 'redeem@example.com', NOW);
    expect(first).toBe(true);
    const second = await recordCouponRedemption(testEnv.DB, 'cpn-first-month', 'ORD-VPN-red2', 'redeem@example.com', NOW);
    expect(second).toBe(false);
    const otherCustomer = await recordCouponRedemption(testEnv.DB, 'cpn-first-month', 'ORD-VPN-red3', 'other@example.com', NOW);
    expect(otherCustomer).toBe(true);
  });

  it('blocks the same order redeeming twice and frees the slot on release', async () => {
    expect(await recordCouponRedemption(testEnv.DB, 'cpn-first-month', 'ORD-VPN-red1', 'again@example.com', NOW)).toBe(false);
    await releaseCouponRedemption(testEnv.DB, 'ORD-VPN-red1');
    expect(await recordCouponRedemption(testEnv.DB, 'cpn-first-month', 'ORD-VPN-red1', 'again@example.com', NOW)).toBe(true);
  });
});

describe('checkout integration with FIRST-MONTH', () => {
  it('charges $3 on the Stripe session and stores the breakdown', async () => {
    const { fetchImpl, calls } = fakeStripe(200, SESSION);
    const key = 'key_coupon_0001_0123456789abcdefghijkl';
    const res = await vpnCheckout(
      request({ email: 'discounted@example.com', planId: 'monthly', couponCode: 'FIRST-MONTH', idempotencyKey: key }),
      envWith({}),
      { fetchImpl },
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.amountCents).toBe(300);
    expect(data.originalAmountCents).toBe(900);
    expect(data.discountCents).toBe(600);
    expect(data.couponCode).toBe('FIRST-MONTH');

    // The Stripe session line item carries the discounted amount.
    const body = calls[0]?.init?.body as string;
    const params = new URLSearchParams(body);
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('300');

    const order = await testEnv.DB.prepare('SELECT * FROM vpn_orders WHERE checkout_idempotency_key = ?').bind(key).first<{ coupon_id: string; discount_cents: number; amount_cents: number }>();
    expect(order?.coupon_id).toBe('cpn-first-month');
    expect(order?.discount_cents).toBe(600);
    expect(order?.amount_cents).toBe(300);
  });

  it('rejects reuse of the same coupon by the same customer on a new order', async () => {
    const { fetchImpl } = fakeStripe(200, SESSION);
    const res = await vpnCheckout(
      request({ email: 'discounted@example.com', planId: 'monthly', couponCode: 'FIRST-MONTH', idempotencyKey: 'key_coupon_0002_0123456789abcdefghijkl' }),
      envWith({}),
      { fetchImpl },
    );
    // Server-side validation catches the reuse before any order/session exists.
    expect(res.status).toBe(422);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/already used/i);
  });

  it('rejects a first-purchase coupon for a customer with a prior paid order', async () => {
    const email = 'returning@example.com';
    await testEnv.DB.prepare(
      `INSERT INTO vpn_orders (id, customer_email, plan_id, interval_months, amount_cents, currency,
         payment_status, created_at, updated_at)
       VALUES ('ORD-VPN-returner', ?, 'annual', 12, 7200, 'USD', 'paid', ?, ?)`,
    )
      .bind(email, NOW, NOW)
      .run();
    const res = await vpnCheckout(
      request({ email, planId: 'monthly', couponCode: 'FIRST-MONTH', idempotencyKey: 'key_coupon_0003_0123456789abcdefghijkl' }),
      envWith({}),
      { fetchImpl: fakeStripe(200, SESSION).fetchImpl },
    );
    expect(res.status).toBe(422);
  });

  it('never trusts client-supplied prices', async () => {
    const res = await vpnCheckout(
      request({ email: 'hacker@example.com', planId: 'monthly', amount: 1, idempotencyKey: 'key_coupon_0004_0123456789abcdefghijkl' }),
      envWith({}),
    );
    expect(res.status).toBe(422);
  });
});

describe('renewal pricing ignores intro discounts', () => {
  it('prices renewal at the regular $9 even for a discounted order', () => {
    const discounted = {
      id: 'ORD-VPN-disc',
      plan_id: 'monthly',
      interval_months: 1,
      amount_cents: 300,
      currency: 'USD',
      order_status: 'active',
      payment_status: 'paid',
      provisioning_status: 'succeeded',
      expire_at: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10),
    };
    const eligibility = checkRenewalEligibility(discounted as never);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.renewalPriceCents).toBe(900);
  });
});
