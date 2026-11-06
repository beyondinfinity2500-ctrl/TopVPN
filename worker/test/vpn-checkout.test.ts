import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, fetch as workerFetch, testEnv } from './helpers';
import { vpnCheckout } from '../routes/vpn';
import { getVpnOrderByIdempotencyKey } from '../vpn/repo';

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
  return `10.70.0.${ip}`;
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
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const SESSION = { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };

beforeAll(async () => {
  await applyMigrations();
});

describe('sandbox checkout gating', () => {
  it('is closed by default', async () => {
    const res = await vpnCheckout(request({ email: 'x@example.com', planId: 'monthly' }), {
      DB: testEnv.DB,
    } as Env);
    expect(res.status).toBe(503);

    const sandboxOff = await vpnCheckout(
      request({ email: 'x@example.com', planId: 'monthly' }),
      envWith({ VPN_SANDBOX_CHECKOUT_ENABLED: 'false' }),
    );
    expect(sandboxOff.status).toBe(503);
  });

  it('requires an idempotency key', async () => {
    const { fetchImpl } = fakeStripe(200, SESSION);
    const res = await vpnCheckout(
      request({ email: 'x@example.com', planId: 'monthly' }),
      envWith({}),
      { fetchImpl },
    );
    expect(res.status).toBe(422);
  });

  it('refuses a live Stripe key even if the flag is on', async () => {
    const res = await vpnCheckout(
      request({ email: 'x@example.com', planId: 'monthly' }),
      envWith({ STRIPE_SECRET_KEY: 'sk_live_should_never_be_used' }),
    );
    expect(res.status).toBe(503);
  });

  it('reports a missing test key', async () => {
    const res = await vpnCheckout(
      request({ email: 'x@example.com', planId: 'monthly' }),
      envWith({ STRIPE_SECRET_KEY: '' }),
    );
    expect(res.status).toBe(503);
  });
});

describe('sandbox checkout flow', () => {
  it('creates a pending order and a one-time test Checkout Session with server price', async () => {
    const { fetchImpl, calls } = fakeStripe(200, SESSION);
    const env = envWith({});

    const res = await vpnCheckout(
      request({ email: 'buyer@example.com', planId: 'annual', idempotencyKey: 'key_annual_0001_0123456789abcdef0123' }),
      env,
      { fetchImpl },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.amountCents).toBe(7200);
    expect(body.checkoutUrl).toBe(SESSION.url);
    expect(body.introApplied).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v1/checkout/sessions');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers['Idempotency-Key']).toBe(`vpn-checkout:${String(body.orderId)}`);

    const params = new URLSearchParams(String(calls[0].init?.body));
    expect(params.get('mode')).toBe('payment'); // one-time; no subscription
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('7200');
    expect(params.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(params.get('client_reference_id')).toBe(String(body.orderId));
    expect(params.get('metadata[domain]')).toBe('vpn');
    expect(params.get('metadata[vpn_order_id]')).toBe(String(body.orderId));
    expect(params.get('payment_intent_data[metadata][vpn_order_id]')).toBe(String(body.orderId));
    expect(params.get('line_items[0][price_data][product_data][description]')).toContain('No automatic renewal');
    expect(params.get('success_url')).toContain('/checkout/success?order=');
    expect(params.get('cancel_url')).toContain('/checkout/cancel?order=');
  });

  it('reuses the same order + session for a duplicated request', async () => {
    const duplicateSession = {
      id: 'cs_dup_test_001',
      url: 'https://checkout.stripe.com/c/pay/cs_dup_test_001',
    };
    const { fetchImpl, calls } = fakeStripe(200, duplicateSession);
    const env = envWith({});
    const key = 'key_duplicate_0001_0123456789abcdef01';

    const first = await vpnCheckout(request({ email: 'dup@example.com', planId: 'monthly', idempotencyKey: key }), env, { fetchImpl });
    const second = await vpnCheckout(request({ email: 'dup@example.com', planId: 'monthly', idempotencyKey: key }), env, { fetchImpl });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = (await first.json()) as Record<string, unknown>;
    const b = (await second.json()) as Record<string, unknown>;
    expect(b.reused).toBe(true);
    expect(b.orderId).toBe(a.orderId);
    expect(calls).toHaveLength(1);

    const stored = await getVpnOrderByIdempotencyKey(testEnv.DB, key);
    expect(stored!.id).toBe(a.orderId);
  });

  it('keeps the pending order when Stripe rejects the session so it can be retried', async () => {
    const { fetchImpl } = fakeStripe(402, { error: { message: 'Your card was declined.' } });
    const env = envWith({});
    const key = 'key_failed_0001_0123456789abcdef01234';

    const res = await vpnCheckout(
      request({ email: 'fail@example.com', planId: 'monthly', idempotencyKey: key }),
      env,
      { fetchImpl },
    );
    expect(res.status).toBe(502);
    const stored = await getVpnOrderByIdempotencyKey(testEnv.DB, key);
    expect(stored!.order_status).toBe('pending_payment');
    expect(stored!.payment_status).toBe('unpaid');
    expect(stored!.failure_reason).toBe('checkout_creation_failed');
  });

  it('retries the same pending order after a failed session creation', async () => {
    const env = envWith({});
    const key = 'key_retry_0001_0123456789abcdef012345';
    const failing = fakeStripe(500, { error: { message: 'provider down' } });
    const first = await vpnCheckout(
      request({ email: 'retry@example.com', planId: 'monthly', idempotencyKey: key }),
      env,
      { fetchImpl: failing.fetchImpl },
    );
    expect(first.status).toBe(502);

    const ok = fakeStripe(200, { id: 'cs_retry_p7', url: 'https://checkout.stripe.com/c/pay/cs_retry_p7' });
    const second = await vpnCheckout(
      request({ email: 'retry@example.com', planId: 'monthly', idempotencyKey: key }),
      env,
      { fetchImpl: ok.fetchImpl },
    );
    expect(second.status).toBe(201);

    const stored = await getVpnOrderByIdempotencyKey(testEnv.DB, key);
    expect(stored!.stripe_session_id).toBe('cs_retry_p7');
  });

  it('does not cancel a live session when two requests race', async () => {
    const env = envWith({});
    const key = 'key_race_0001_0123456789abcdef0123456';
    const fake = fakeStripe(200, {
      id: 'cs_race_p8',
      url: 'https://checkout.stripe.com/c/pay/cs_race_p8',
    });

    const [a, b] = await Promise.all([
      vpnCheckout(request({ email: 'race@example.com', planId: 'monthly', idempotencyKey: key }), env, {
        fetchImpl: fake.fetchImpl,
      }),
      vpnCheckout(request({ email: 'race@example.com', planId: 'monthly', idempotencyKey: key }), env, {
        fetchImpl: fake.fetchImpl,
      }),
    ]);

    // Both requests must resolve without a server error; one wins the attach.
    expect([a.status, b.status].every((s) => [200, 201, 409].includes(s))).toBe(true);
    const stored = await getVpnOrderByIdempotencyKey(testEnv.DB, key);
    expect(stored!.order_status).toBe('pending_payment');
    expect(stored!.stripe_checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_race_p8');
  });

  it('stays unreachable through the Worker while the flags are off', async () => {
    const res = await workerFetch('/api/vpn/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', planId: 'monthly' }),
    });
    expect(res.status).toBe(503);
  });
});
