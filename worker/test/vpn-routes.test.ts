import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { adminLogin, applyMigrations, fetch, signWebhook, testEnv } from './helpers';
import { hashPassword } from '../auth';
import {
  createVpnOrderRoute,
  vpnStripeWebhook,
} from '../routes/vpn';
import { getVpnOrder, insertVpnOrder, markVpnPaid } from '../vpn/repo';
import { provisioningUsername } from '../provisioning';

const SECRET = 'whsec_vpn_test_secret';

function envWith(extra: Partial<Env>): Env {
  return { DB: testEnv.DB, VPN_PROVISIONING_SECRET: 'test-provisioning-secret', ...extra } as unknown as Env;
}

const envEnabled = envWith({ VPN_SALES_ENABLED: 'true' });
const envWebhook = envWith({ VPN_SALES_ENABLED: 'true', STRIPE_VPN_WEBHOOK_SECRET: SECRET });

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.60.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

async function createOrderRoute(email = 'route@example.com', plan = 'monthly', env: Env = envEnabled) {
  const response = await createVpnOrderRoute(
    new Request('https://topvpn.test/api/vpn/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ email, planId: plan }),
    }),
    env,
  );
  return { response, data: (await response.json()) as Record<string, unknown> };
}

function paidEvent(orderId: string, overrides: Record<string, unknown> = {}, eventId?: string) {
  return {
    id: eventId ?? `evt_${crypto.randomUUID()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${crypto.randomUUID()}`,
        payment_status: 'paid',
        amount_total: 900,
        currency: 'usd',
        payment_intent: 'pi_test',
        metadata: { domain: 'vpn', vpn_order_id: orderId },
        ...overrides,
      },
    },
  };
}

function eventOfType(
  type: string,
  orderId: string,
  objectOverrides: Record<string, unknown> = {},
) {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type,
    data: {
      object: {
        id: `obj_${crypto.randomUUID()}`,
        payment_status: 'paid',
        amount_total: 900,
        currency: 'usd',
        payment_intent: `pi_${crypto.randomUUID()}`,
        metadata: { domain: 'vpn', vpn_order_id: orderId },
        ...objectOverrides,
      },
    },
  };
}

async function postWebhook(event: unknown, env: Env = envWebhook, signature?: string) {  const raw = JSON.stringify(event);
  const sig = signature ?? (await signWebhook(SECRET, raw));
  return vpnStripeWebhook(
    new Request('https://topvpn.test/api/vpn/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body: raw,
    }),
    env,
  );
}

beforeAll(async () => {
  await applyMigrations();
  // Test fixture only: provide a non-empty admin password hash so the admin
  // auth path is exercised end-to-end. Production auth is unchanged.
  testEnv.ADMIN_PASSWORD_HASH = await hashPassword('test-admin-password-1234');
});

describe('public plan catalog', () => {
  it('is readable while checkout is closed and never leaks provider ids', async () => {
    const res = await fetch('/api/vpn/plans');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { currency: string; checkout: string; plans: unknown[] };
    expect(data.currency).toBe('USD');
    expect(data.checkout).toBe('closed');
    expect(data.plans).toHaveLength(3);
    expect(JSON.stringify(data)).not.toContain('providerPlanId');
  });
});

describe('order creation', () => {
  it('is closed by default', async () => {
    const res = await fetch('/api/vpn/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', planId: 'monthly' }),
    });
    expect(res.status).toBe(503);
  });

  it('creates a pending order with the server price', async () => {
    const { response, data } = await createOrderRoute();
    expect(response.status).toBe(201);
    expect(data.amountCents).toBe(900);
    expect(data.currency).toBe('USD');
    expect(data.paymentStatus).toBe('unpaid');
    const order = await getVpnOrder(testEnv.DB, String(data.orderId));
    expect(order).not.toBeNull();
  });

  it('stores the customer email normalized to lowercase', async () => {
    const { data } = await createOrderRoute('Normalize@Example.COM');
    const order = await getVpnOrder(testEnv.DB, String(data.orderId));
    expect(order!.customer_email).toBe('normalize@example.com');
  });

  it('rejects client-supplied prices and unknown plans', async () => {
    const priced = await createVpnOrderRoute(
      new Request('https://topvpn.test/api/vpn/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify({ email: 'x@example.com', planId: 'monthly', amountCents: 1 }),
      }),
      envEnabled,
    );
    expect(priced.status).toBe(422);

    const unknown = await createOrderRoute('x@example.com', 'weekly');
    expect(unknown.response.status).toBe(422);

    const badEmail = await createOrderRoute('not-an-email');
    expect(badEmail.response.status).toBe(422);
  });

  it('never applies the intro price while verified identity is missing', async () => {
    const envIntro = envWith({ VPN_SALES_ENABLED: 'true', VPN_INTRO_ENABLED: 'true' });
    const { response, data } = await createOrderRoute('intro@example.com', 'monthly', envIntro);
    expect(response.status).toBe(201);
    expect(data.amountCents).toBe(900);
    expect(data.introApplied).toBe(false);
  });
});

describe('payment webhook', () => {
  it('requires only the webhook secret — closing checkout must not drop existing orders', async () => {
    const event = paidEvent('ORD-VPN-x');
    expect((await postWebhook(event, envWith({}))).status).toBe(503);

    const { data } = await createOrderRoute();
    const envNoSales = envWith({ STRIPE_VPN_WEBHOOK_SECRET: SECRET });
    const res = await postWebhook(paidEvent(String(data.orderId)), envNoSales);
    expect(res.status).toBe(200);
    const order = await getVpnOrder(testEnv.DB, String(data.orderId));
    expect(order!.payment_status).toBe('paid');
  });

  it('retries an event whose order is unknown instead of dropping it', async () => {
    const res = await postWebhook(paidEvent('ORD-VPN-does-not-exist'));
    expect(res.status).toBe(500);
  });

  it('rejects a paid event with no charged amount', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const event = paidEvent(orderId);
    delete (event.data.object as Record<string, unknown>).amount_total;

    const res = await postWebhook(event);
    expect(res.status).toBe(400);
    expect((await getVpnOrder(testEnv.DB, orderId))!.payment_status).toBe('unpaid');
  });

  it('records a refund that arrives before the paid event and refuses the late payment', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    const refundEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_${crypto.randomUUID()}`,
          amount_refunded: 900,
          currency: 'usd',
          metadata: { domain: 'vpn', vpn_order_id: orderId },
        },
      },
    };
    const refund = (await (await postWebhook(refundEvent)).json()) as Record<string, unknown>;
    expect(refund.refunded).toBe(true);

    const afterRefund = await getVpnOrder(testEnv.DB, orderId);
    expect(afterRefund!.payment_status).toBe('refunded');
    expect(afterRefund!.order_status).toBe('cancelled');

    const late = (await (await postWebhook(paidEvent(orderId))).json()) as Record<string, unknown>;
    expect(late.ignored).toBe('order_cancelled');
    expect((await getVpnOrder(testEnv.DB, orderId))!.payment_status).toBe('refunded');
  });

  it('does not treat a partial refund as a full refund', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    await postWebhook(paidEvent(orderId));

    const partial = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_${crypto.randomUUID()}`,
          amount_refunded: 300,
          currency: 'usd',
          metadata: { domain: 'vpn', vpn_order_id: orderId },
        },
      },
    };
    const body = (await (await postWebhook(partial)).json()) as Record<string, unknown>;
    expect(body.ignored).toBe('partial_refund');

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.payment_status).toBe('paid');
    expect(order!.order_status).not.toBe('refunded');
  });

  it('resolves a refund by payment_intent when metadata is absent', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const paymentIntent = `pi_${crypto.randomUUID()}`;
    await postWebhook(paidEvent(orderId, { payment_intent: paymentIntent }));

    const refundEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'refund.created',
      data: {
        object: {
          id: `re_${crypto.randomUUID()}`,
          object: 'refund',
          amount: 900,
          currency: 'usd',
          payment_intent: paymentIntent,
          status: 'succeeded',
        },
      },
    };
    const body = (await (await postWebhook(refundEvent)).json()) as Record<string, unknown>;
    expect(body.refunded).toBe(true);
    expect((await getVpnOrder(testEnv.DB, orderId))!.order_status).toBe('refunded');
  });

  it('ignores a refund that has not succeeded yet', async () => {    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const paymentIntent = `pi_${crypto.randomUUID()}`;
    await postWebhook(paidEvent(orderId, { payment_intent: paymentIntent }));

    const refundEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'refund.created',
      data: {
        object: {
          id: `re_${crypto.randomUUID()}`,
          object: 'refund',
          amount: 900,
          currency: 'usd',
          payment_intent: paymentIntent,
          status: 'pending',
        },
      },
    };
    const body = (await (await postWebhook(refundEvent)).json()) as Record<string, unknown>;
    expect(body.ignored).toBe('refund_not_succeeded');
    expect((await getVpnOrder(testEnv.DB, orderId))!.order_status).not.toBe('refunded');
  });

  it('accepts asynchronous payment success as paid', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    const res = await postWebhook(eventOfType('checkout.session.async_payment_succeeded', orderId));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.paid).toBe(true);
    expect((await getVpnOrder(testEnv.DB, orderId))!.payment_status).toBe('paid');
  });

  it('records an asynchronous payment failure without paying or provisioning', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    const res = await postWebhook(
      eventOfType('checkout.session.async_payment_failed', orderId, { payment_status: 'unpaid' }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ignored).toBe('async_payment_failed');

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.payment_status).toBe('unpaid');
    expect(order!.order_status).toBe('pending_payment');
    expect(order!.provisioning_status).toBe('none');
    expect(order!.failure_reason).toBe('async_payment_failed');
  });

  it('does not reprocess a failure event twice', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const event = eventOfType('checkout.session.async_payment_failed', orderId, {
      payment_status: 'unpaid',
    });

    const first = (await (await postWebhook(event)).json()) as Record<string, unknown>;
    expect(first.ignored).toBe('async_payment_failed');

    const second = (await (await postWebhook(event)).json()) as Record<string, unknown>;
    expect(second.duplicate).toBe(true);
  });

  it('records a failed refund without marking the order refunded', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    await postWebhook(eventOfType('checkout.session.completed', orderId));

    const res = await postWebhook(
      eventOfType('refund.failed', orderId, { status: 'failed', amount: 900 }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ignored).toBe('refund_failed');

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.payment_status).toBe('paid');
    expect(order!.order_status).not.toBe('refunded');
    expect(order!.failure_reason).toBe('refund_failed');
  });

  it('resolves refund.failed by payment_intent when metadata is absent', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const paymentIntent = `pi_${crypto.randomUUID()}`;
    await postWebhook(paidEvent(orderId, { payment_intent: paymentIntent }));

    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'refund.failed',
      data: {
        object: {
          id: `re_${crypto.randomUUID()}`,
          object: 'refund',
          amount: 900,
          currency: 'usd',
          payment_intent: paymentIntent,
          status: 'failed',
        },
      },
    };
    const body = (await (await postWebhook(event)).json()) as Record<string, unknown>;
    expect(body.ignored).toBe('refund_failed');

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.payment_status).toBe('paid');
    expect(order!.order_status).not.toBe('refunded');
    expect(order!.failure_reason).toBe('refund_failed');
  });

  it('rejects a signed but malformed webhook body', async () => {
    const raw = 'not-json';
    const sig = await signWebhook(SECRET, raw);
    const res = await vpnStripeWebhook(
      new Request('https://topvpn.test/api/vpn/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
        body: raw,
      }),
      envWebhook,
    );
    expect(res.status).toBe(400);
  });

  it('ignores advertising-shaped events and leaves VPN orders untouched', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    const adsEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_ads_${crypto.randomUUID()}`,
          payment_status: 'paid',
          amount_total: 3000,
          currency: 'usd',
          payment_intent: `pi_ads_${crypto.randomUUID()}`,
          metadata: { order_id: 'ORD-AD-ONLY' },
        },
      },
    };
    const body = (await (await postWebhook(adsEvent)).json()) as Record<string, unknown>;
    expect(body.ignored).toBe('not_vpn');
    expect((await getVpnOrder(testEnv.DB, orderId))!.payment_status).toBe('unpaid');
  });

  it('rejects an invalid signature', async () => {
    const res = await postWebhook(paidEvent('ORD-VPN-x'), envWebhook, 't=1,v1=deadbeef');
    expect(res.status).toBe(400);
  });

  it('marks an order paid, but records provisioning failure separately', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    const res = await postWebhook(paidEvent(orderId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.paid).toBe(true);
    expect(body.provisioning).toBe('provisioning_failed');

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.payment_status).toBe('paid');
    expect(order!.order_status).toBe('provisioning_failed');
    expect(order!.provisioning_status).toBe('failed');
    expect(order!.failure_reason).toBe('provider_not_configured');
  });

  it('ignores a duplicate event id', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const event = paidEvent(orderId);

    expect((await postWebhook(event)).status).toBe(200);
    const second = await postWebhook(event);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>).duplicate).toBe(true);

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.order_status).toBe('provisioning_failed');
  });

  it('rejects an amount mismatch without marking the order paid', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    const res = await postWebhook(paidEvent(orderId, { amount_total: 100 }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ignored).toBe('amount_mismatch');

    const order = await getVpnOrder(testEnv.DB, orderId);
    expect(order!.payment_status).toBe('unpaid');
    expect(order!.failure_reason).toBe('payment_amount_mismatch');
  });

  it('records a dispute for review without changing payment/provisioning state', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    await postWebhook(eventOfType('checkout.session.completed', orderId));
    const before = await getVpnOrder(testEnv.DB, orderId);

    const res = await postWebhook(
      eventOfType('charge.dispute.created', orderId, { status: 'needs_response', amount: 900, currency: 'usd' }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ignored).toBe('dispute_recorded');

    const after = await getVpnOrder(testEnv.DB, orderId);
    expect(after!.payment_status).toBe(before!.payment_status);
    expect(after!.order_status).toBe(before!.order_status);
    expect(after!.provisioning_status).toBe(before!.provisioning_status);
  });

  it('ignores events that are not for the VPN domain', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    const event = paidEvent(orderId, { metadata: { domain: 'ads', vpn_order_id: orderId } });

    const body = (await (await postWebhook(event)).json()) as Record<string, unknown>;
    expect(body.ignored).toBe('not_vpn');
    expect((await getVpnOrder(testEnv.DB, orderId))!.payment_status).toBe('unpaid');
  });

  it('ignores events with no VPN markers at all', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    // Event with no domain and no vpn_order_id — should be ignored, not processed.
    // Use a unique payment_intent to avoid matching existing orders.
    const event = paidEvent(orderId, { metadata: {}, payment_intent: `pi_unique_${crypto.randomUUID()}` });

    const body = (await (await postWebhook(event)).json()) as Record<string, unknown>;
    expect(body.ignored).toBe('not_vpn');
  });

  it('ignores events with a non-VPN order id prefix', async () => {
    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);
    // vpn_order_id that doesn't follow ORD-VPN- prefix — should be ignored.
    // Use a unique payment_intent to avoid matching existing orders.
    const event = paidEvent(orderId, { metadata: { domain: 'vpn', vpn_order_id: 'ORD-123' }, payment_intent: `pi_unique_${crypto.randomUUID()}` });

    const res = await postWebhook(event);
    // Non-VPN order id prefix → not resolved → 500 (unknown order), never processed.
    expect(res.status).toBe(500);
  });

  it('never revives a refunded order from an old or replayed payment event', async () => {    const { data } = await createOrderRoute();
    const orderId = String(data.orderId);

    await postWebhook(paidEvent(orderId));

    const refundEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_${crypto.randomUUID()}`,
          amount_refunded: 900,
          currency: 'usd',
          metadata: { domain: 'vpn', vpn_order_id: orderId },
        },
      },
    };
    const refund = (await (await postWebhook(refundEvent)).json()) as Record<string, unknown>;
    expect(refund.refunded).toBe(true);
    expect((await getVpnOrder(testEnv.DB, orderId))!.order_status).toBe('refunded');

    const replay = (await (await postWebhook(paidEvent(orderId))).json()) as Record<string, unknown>;
    expect(replay.ignored).toBe('order_refunded');
    expect((await getVpnOrder(testEnv.DB, orderId))!.order_status).toBe('refunded');
  });
});

describe('admin VPN routes', () => {
  async function seedOrder(): Promise<string> {
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'admin-view@example.com',
      customerName: null,
      planId: 'annual',
      intervalMonths: 12,
      amountCents: 7200,
      currency: 'USD',
      providerUsername: provisioningUsername(id),
      now: new Date().toISOString(),
    });
    return id;
  }

  it('requires an admin session', async () => {
    const id = await seedOrder();
    const res = await fetch(`/admin/api/vpn/orders/${id}`);
    expect(res.status).toBe(401);
  });

  it('returns sanitized provisioning state to an admin', async () => {
    const id = await seedOrder();
    const login = await adminLogin('test-admin-password-1234');
    const res = await fetch(`/admin/api/vpn/orders/${id}`, { headers: { Cookie: login.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.paymentStatus).toBe('unpaid');
    expect(body.provisioningStatus).toBe('none');
    expect(body).not.toHaveProperty('stripe_session_id');
  });

  it('allows an admin to retry provisioning, but only with CSRF', async () => {
    const id = await seedOrder();
    await markVpnPaid(testEnv.DB, id, { now: new Date().toISOString() });
    const login = await adminLogin('test-admin-password-1234');

    const noCsrf = await fetch(`/admin/api/vpn/orders/${id}/provision`, {
      method: 'POST',
      headers: { Cookie: login.cookie },
    });
    expect(noCsrf.status).toBe(403);

    const res = await fetch(`/admin/api/vpn/orders/${id}/provision`, {
      method: 'POST',
      headers: { Cookie: login.cookie, 'X-CSRF-Token': login.csrf },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('provisioning_failed'); // provider is not configured in tests
  });
});
