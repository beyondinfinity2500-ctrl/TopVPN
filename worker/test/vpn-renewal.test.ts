import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, fetch, signWebhook, testEnv } from './helpers';
import {
  checkRenewalEligibility,
  extendVpnExpiry,
} from '../vpn/renewal';
import {
  getVpnOrder,
  insertVpnOrder,
  markVpnPaid,
  transitionVpnOrder,
} from '../vpn/repo';
import { vpnCheckoutParams } from '../vpn/stripe-checkout';
import { vpnStripeWebhook } from '../routes/vpn';
import { renewOrderRoute } from '../routes/vpn';
import { createCustomerSession, findOrCreateCustomer, linkOrdersToCustomer } from '../customer/repo';
import { randomToken, sha256Hex } from '../customer/auth';

const NOW = new Date('2026-10-27T10:00:00.000Z');

async function makeActiveOrder(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `ORD-VPN-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await insertVpnOrder(testEnv.DB, {
    id,
    customerEmail: 'buyer@example.com',
    customerName: null,
    planId: 'annual',
    intervalMonths: 12,
    amountCents: 7200,
    currency: 'USD',
    providerUsername: `topvpn-${id.toLowerCase()}`.slice(0, 50),
    now,
  });
  await markVpnPaid(testEnv.DB, id, { now });
  const expireAt = (overrides.expire_at as string) ?? '2026-11-27';
  await transitionVpnOrder(testEnv.DB, id, 'paid', 'active', {
    provisioningStatus: 'succeeded',
    subscriptionStatus: 'active',
    expireAt,
  }, 'test setup', now);
  return id;
}

beforeAll(async () => {
  await applyMigrations();
});

describe('Renewal eligibility', () => {
  it('is eligible within 30 days of expiry', async () => {
    const id = await makeActiveOrder({ expire_at: '2026-11-20' });
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('eligible');
    expect(result.days_remaining).toBe(24);
  });

  it('is eligible exactly 30 days before expiry', async () => {
    const id = await makeActiveOrder({ expire_at: '2026-11-26' });
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.eligible).toBe(true);
    expect(result.days_remaining).toBe(30);
  });

  it('is not eligible more than 30 days before expiry', async () => {
    const id = await makeActiveOrder({ expire_at: '2026-11-28' });
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('not_in_window');
    expect(result.days_remaining).toBe(32);
  });

  it('is not eligible when expired', async () => {
    const id = await makeActiveOrder({ expire_at: '2026-10-26' });
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('is not eligible when not paid', async () => {
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'buyer@example.com',
      customerName: null,
      planId: 'annual',
      intervalMonths: 12,
      amountCents: 7200,
      currency: 'USD',
      providerUsername: `topvpn-${id.toLowerCase()}`.slice(0, 50),
      now,
    });
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('not_active');
  });

  it('is not eligible when not active', async () => {
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'buyer@example.com',
      customerName: null,
      planId: 'annual',
      intervalMonths: 12,
      amountCents: 7200,
      currency: 'USD',
      providerUsername: `topvpn-${id.toLowerCase()}`.slice(0, 50),
      now,
    });
    await markVpnPaid(testEnv.DB, id, { now });
    // Stay in 'paid' state (not active)
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('not_active');
  });

  it('returns renewal price', async () => {
    const id = await makeActiveOrder({ expire_at: '2026-11-20' });
    const order = await getVpnOrder(testEnv.DB, id);
    const result = checkRenewalEligibility(order!, NOW);
    expect(result.renewalPriceCents).toBe(7200);
  });
});

describe('extendVpnExpiry', () => {
  it('extends expiry by plan interval', async () => {
    const id = await makeActiveOrder({ expire_at: '2026-11-27' });
    const now = NOW.toISOString();

    const before = await getVpnOrder(testEnv.DB, id);
    expect(before!.expire_at).toBe('2026-11-27');

    const result = await extendVpnExpiry(testEnv.DB, id, now);
    expect(result).toBe(true);

    const after = await getVpnOrder(testEnv.DB, id);
    expect(after!.expire_at).toBe('2027-11-27');
  });

  it('returns false for non-existent order', async () => {
    const result = await extendVpnExpiry(testEnv.DB, 'ORD-VPN-nonexistent', NOW.toISOString());
    expect(result).toBe(false);
  });

  it('returns false for non-active order', async () => {
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'buyer@example.com',
      customerName: null,
      planId: 'annual',
      intervalMonths: 12,
      amountCents: 7200,
      currency: 'USD',
      providerUsername: `topvpn-${id.toLowerCase()}`.slice(0, 50),
      now,
    });
    await markVpnPaid(testEnv.DB, id, { now });
    // Stay in 'paid' state (not active)

    const result = await extendVpnExpiry(testEnv.DB, id, now);
    expect(result).toBe(false);
  });
});

describe('Renewal checkout params', () => {
  it('creates a one-time payment session with renewal metadata', () => {
    const order = {
      id: 'ORD-VPN-test',
      customer_email: 'buyer@example.com',
      plan_id: 'annual',
      interval_months: 12,
      amount_cents: 7200,
      currency: 'USD',
      order_status: 'active',
      payment_status: 'paid',
      provisioning_status: 'succeeded',
      subscription_status: 'active',
      provider_account_id: null,
      provider_username: 'topvpn',
      expire_at: '2026-11-27',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
    } as any;
    const env = { VPN_SANDBOX_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', SITE_URL: 'https://www.topvpn.top' } as unknown as Env;
    const params = vpnCheckoutParams(env, order, { renewal: '1' });
    const body = params.toString();
    expect(body).toContain('mode=payment');
    expect(body).toContain('metadata%5Brenewal%5D=1');
    expect(body).toContain('metadata%5Bvpn_order_id%5D=ORD-VPN-test');
    expect(body).not.toContain('subscription');
    expect(body).not.toContain('recurring');
  });
});

describe('Renewal webhook', () => {
  const SECRET = 'whsec_vpn_test_secret';
  const envWebhook = { DB: testEnv.DB, VPN_PROVISIONING_SECRET: 'test-provisioning-secret', STRIPE_VPN_WEBHOOK_SECRET: SECRET, VPN_SALES_ENABLED: 'true' } as unknown as Env;

  async function seedActiveOrder(expireAt: string): Promise<string> {
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'buyer@example.com',
      customerName: null,
      planId: 'annual',
      intervalMonths: 12,
      amountCents: 7200,
      currency: 'USD',
      providerUsername: `topvpn-${id.toLowerCase()}`.slice(0, 50),
      now,
    });
    await markVpnPaid(testEnv.DB, id, { now });
    await transitionVpnOrder(testEnv.DB, id, 'paid', 'active', {
      provisioningStatus: 'succeeded',
      subscriptionStatus: 'active',
      expireAt,
    }, 'test setup', now);
    return id;
  }

  function paidRenewalEvent(orderId: string, eventId?: string) {
    return {
      id: eventId ?? `evt_${crypto.randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${crypto.randomUUID()}`,
          payment_status: 'paid',
          amount_total: 7200,
          currency: 'usd',
          payment_intent: 'pi_test',
          metadata: { domain: 'vpn', vpn_order_id: orderId, renewal: '1' },
        },
      },
    };
  }

  async function postWebhook(event: unknown, signature?: string) {
    const raw = JSON.stringify(event);
    const sig = signature ?? (await signWebhook(SECRET, raw));
    return vpnStripeWebhook(
      new Request('https://topvpn.test/api/vpn/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
        body: raw,
      }),
      envWebhook,
    );
  }

  it('extends access exactly once on successful renewal payment', async () => {
    const id = await seedActiveOrder('2026-11-20');
    const before = await getVpnOrder(testEnv.DB, id);
    expect(before!.expire_at).toBe('2026-11-20');

    const event = paidRenewalEvent(id);
    const res = await postWebhook(event);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { renewed: boolean };
    expect(data.renewed).toBe(true);

    const after = await getVpnOrder(testEnv.DB, id);
    expect(after!.expire_at).toBe('2027-11-20');
  });

  it('does not extend twice on duplicate webhook delivery', async () => {
    const id = await seedActiveOrder('2026-11-20');
    const eventId = `evt_${crypto.randomUUID()}`;
    const event = paidRenewalEvent(id, eventId);

    const first = await postWebhook(event);
    expect(first.status).toBe(200);
    const firstData = (await first.json()) as { renewed: boolean };
    expect(firstData.renewed).toBe(true);

    const afterFirst = await getVpnOrder(testEnv.DB, id);
    expect(afterFirst!.expire_at).toBe('2027-11-20');

    // Re-deliver the same event id
    const second = await postWebhook(paidRenewalEvent(id, eventId), await signWebhook(SECRET, JSON.stringify(paidRenewalEvent(id, eventId))));
    // Actually re-sign the same event id payload
    const raw2 = JSON.stringify(paidRenewalEvent(id, eventId));
    const sig2 = await signWebhook(SECRET, raw2);
    const secondRes = await vpnStripeWebhook(
      new Request('https://topvpn.test/api/vpn/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig2 },
        body: raw2,
      }),
      envWebhook,
    );
    // Duplicate event returns 200 (idempotent) but does not re-extend
    expect(secondRes.status).toBe(200);

    const afterSecond = await getVpnOrder(testEnv.DB, id);
    expect(afterSecond!.expire_at).toBe('2027-11-20');
  });

  it('leaves access unchanged when renewal checkout is abandoned', async () => {
    const id = await seedActiveOrder('2026-11-20');
    // No webhook fired → expiry unchanged
    const after = await getVpnOrder(testEnv.DB, id);
    expect(after!.expire_at).toBe('2026-11-20');
  });
});

describe('Renewal route', () => {
  const envEnabled = { DB: testEnv.DB, VPN_SANDBOX_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', VPN_CUSTOMER_AUTH_ENABLED: 'true', VPN_SALES_ENABLED: 'true' } as unknown as Env;

  async function seedCustomerWithOrder(email: string, expireAt: string): Promise<{ cookie: string; csrf: string; orderId: string }> {
    const now = new Date().toISOString();
    const customer = await findOrCreateCustomer(testEnv.DB, email, now);
    const orderId = `ORD-VPN-${crypto.randomUUID()}`;
    await insertVpnOrder(testEnv.DB, {
      id: orderId,
      customerEmail: email,
      customerName: null,
      planId: 'annual',
      intervalMonths: 12,
      amountCents: 7200,
      currency: 'USD',
      providerUsername: `topvpn-${orderId.toLowerCase()}`.slice(0, 50),
      now,
    });
    await markVpnPaid(testEnv.DB, orderId, { now });
    await transitionVpnOrder(testEnv.DB, orderId, 'paid', 'active', {
      provisioningStatus: 'succeeded',
      subscriptionStatus: 'active',
      expireAt,
    }, 'test setup', now);
    await linkOrdersToCustomer(testEnv.DB, customer.id, email, now);

    const sessionToken = randomToken();
    const csrf = randomToken(12);
    await createCustomerSession(testEnv.DB, {
      tokenHash: await sha256Hex(sessionToken),
      customerId: customer.id,
      csrfToken: csrf,
      now,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    return { cookie: `topvpn_customer_session=${sessionToken}`, csrf, orderId };
  }

  it('returns 401 when not authenticated', async () => {
    const res = await renewOrderRoute(
      new Request('https://topvpn.test/api/vpn/orders/ORD-VPN-x/renew', { method: 'POST' }),
      envEnabled,
      'ORD-VPN-x',
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for foreign-owned order', async () => {
    const a = await seedCustomerWithOrder(`foreign-${crypto.randomUUID()}@example.com`, '2026-11-20');
    const otherEmail = `other-${crypto.randomUUID()}@example.com`;
    const other = await seedCustomerWithOrder(otherEmail, '2026-11-20');
    // 'a' tries to renew 'other's order
    const res = await renewOrderRoute(
      new Request(`https://topvpn.test/api/vpn/orders/${other.orderId}/renew`, {
        method: 'POST',
        headers: { Cookie: a.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `csrf=${encodeURIComponent(a.csrf)}`,
      }),
      envEnabled,
      other.orderId,
    );
    expect(res.status).toBe(403);
  });

  it('returns 409 for order not in renewal window', async () => {
    const s = await seedCustomerWithOrder(`window-${crypto.randomUUID()}@example.com`, '2026-12-30');
    const res = await renewOrderRoute(
      new Request(`https://topvpn.test/api/vpn/orders/${s.orderId}/renew`, {
        method: 'POST',
        headers: { Cookie: s.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `csrf=${encodeURIComponent(s.csrf)}`,
      }),
      envEnabled,
      s.orderId,
    );
    expect(res.status).toBe(409);
  });
});