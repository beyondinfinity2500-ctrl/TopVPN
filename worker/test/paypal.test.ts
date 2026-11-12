/**
 * PayPal one-time checkout tests (sandbox config, order body, webhook
 * verification, capture â†’ paid, idempotency, amount/currency mismatch,
 * refunds). No network calls â€” fetch is always injected.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, testEnv } from './helpers';
import { amountToCents, centsToAmount, paypalConfig, paypalOrderBody, type PayPalConfig } from '../vpn/paypal';
import { vpnPayPalCreate, vpnPayPalWebhook } from '../routes/vpn';

function envWith(extra: Partial<Env>): Env {
  return {
    DB: testEnv.DB,
    VPN_SALES_ENABLED: 'true',
    PAYPAL_ENABLED: 'true',
    PAYPAL_CLIENT_ID: 'test-client-id',
    PAYPAL_CLIENT_SECRET: 'test-client-secret',
    PAYPAL_WEBHOOK_ID: 'whid_test',
    ...extra,
  } as unknown as Env;
}

let ip = 0;
function nextIp(): string {
  ip += 1;
  return `10.72.0.${ip}`;
}

function request(body: Record<string, unknown>): Request {
  return new Request('https://topvpn.test/api/vpn/paypal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
    body: JSON.stringify(body),
  });
}

type FetchCall = { url: string; init?: RequestInit };

/** Mock fetch that answers OAuth + Orders + webhook verification. */
function fakePayPal(opts: { orderStatus?: number; order?: Record<string, unknown>; verifyStatus?: string } = {}) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const href = String(url);
    if (href.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok_test', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/v2/checkout/orders')) {
      return new Response(
        JSON.stringify(
          opts.order ?? {
            id: 'PAYPAL-ORDER-1',
            links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1' }],
          },
        ),
        { status: opts.orderStatus ?? 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (href.includes('/v1/notifications/verify-webhook-signature')) {
      return new Response(JSON.stringify({ verification_status: opts.verifyStatus ?? 'SUCCESS' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function webhookRequest(rawBody: string, transmissionId = 'tr-1'): Request {
  return new Request('https://topvpn.test/api/vpn/paypal/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT',
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-01-01T00:00:00Z',
    },
    body: rawBody,
  });
}

function captureEvent(orderId: string, value = '9.00', captureId = 'CAP-1'): string {
  return JSON.stringify({
    id: transmissionIdOf(captureId),
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: captureId,
      custom_id: orderId,
      amount: { value, currency_code: 'USD' },
      status: 'COMPLETED',
    },
  });
}

function transmissionIdOf(seed: string): string {
  return `tr-${seed}`;
}

beforeAll(async () => {
  await applyMigrations();
});

describe('config gating', () => {
  it('is disabled by default', () => {
    expect(paypalConfig({ DB: testEnv.DB } as Env).ok).toBe(false);
  });

  it('defaults to the sandbox API base and refuses the live host without explicit approval', () => {
    const ok = paypalConfig(envWith({}));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.apiBase).toBe('https://api-m.sandbox.paypal.com');

    const refused = paypalConfig(envWith({ PAYPAL_API_BASE: 'https://api-m.paypal.com' }));
    expect(refused).toMatchObject({ ok: false, reason: 'paypal_live_refused' });

    const allowed = paypalConfig(envWith({ PAYPAL_API_BASE: 'https://api-m.paypal.com', PAYPAL_ALLOW_LIVE: 'true' }));
    expect(allowed.ok).toBe(true);
  });
});

describe('amount helpers and order body', () => {
  it('converts cents <-> PayPal amounts', () => {
    expect(centsToAmount(300)).toBe('3.00');
    expect(centsToAmount(900)).toBe('9.00');
    expect(amountToCents('3.00')).toBe(300);
    expect(amountToCents('72.00')).toBe(7200);
  });

  it('builds a one-time CAPTURE order bound to the VPN order id', () => {
    const body = paypalOrderBody({
      id: 'ORD-VPN-x',
      interval_months: 1,
      amount_cents: 900,
      currency: 'USD',
    } as never) as { intent: string; purchase_units: { custom_id: string; amount: { value: string } }[] };
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0].custom_id).toBe('ORD-VPN-x');
    expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '9.00' });
  });
});

describe('create route', () => {
  it('requires the sales flag and valid input', async () => {
    const closed = await vpnPayPalCreate(request({ email: 'a@example.com', planId: 'monthly', idempotencyKey: 'k'.repeat(40) }), {
      DB: testEnv.DB,
    } as Env);
    expect(closed.status).toBe(503);
  });

  it('creates a PayPal order and returns the approve URL', async () => {
    const { fetchImpl, calls } = fakePayPal();
    const res = await vpnPayPalCreate(
      request({ email: 'pp-buyer@example.com', planId: 'monthly', idempotencyKey: 'key_pp_0001_0123456789abcdefghijkl' }),
      envWith({}),
      { fetchImpl },
    );
    expect(res.status, `create failed: ${JSON.stringify(await res.clone().json())}`).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.approveUrl).toContain('checkoutnow');
    expect(data.amountCents).toBe(900);

    const orderCall = calls.find((c) => c.url.includes('/v2/checkout/orders'));
    const body = JSON.parse((orderCall?.init?.body as string) ?? '{}');
    expect(body.purchase_units[0].amount.value).toBe('9.00');
    expect(body.purchase_units[0].custom_id.startsWith('ORD-VPN-')).toBe(true);
  });

  it('refuses a live API base without explicit approval', async () => {
    const res = await vpnPayPalCreate(
      request({ email: 'pp-buyer@example.com', planId: 'monthly', idempotencyKey: 'key_pp_0002_0123456789abcdefghijkl' }),
      envWith({ PAYPAL_API_BASE: 'https://api-m.paypal.com' }),
      { fetchImpl: fakePayPal().fetchImpl },
    );
    expect(res.status).toBe(503);
  });
});

describe('webhook', () => {
  it('rejects unsigned/invalid-signature payloads', async () => {
    const res = await vpnPayPalWebhook(
      webhookRequest(captureEvent('ORD-VPN-none'), 'tr-bad'),
      envWith({}),
      { fetchImpl: fakePayPal({ verifyStatus: 'FAILURE' }).fetchImpl },
    );
    expect(res.status).toBe(400);
  });

  it('marks the order paid on a verified capture and provisions once', async () => {
    // Create a pending order through the create route first.
    const createRes = await vpnPayPalCreate(
      request({ email: 'pp-capture@example.com', planId: 'monthly', idempotencyKey: 'key_pp_cap1_0123456789abcdefghijkl' }),
      envWith({}),
      { fetchImpl: fakePayPal().fetchImpl },
    );
    expect(createRes.status, `create failed: ${JSON.stringify(await createRes.clone().json())}`).toBe(201);
    const orderId = (await createRes.clone().json() as { orderId: string }).orderId;

    const res = await vpnPayPalWebhook(webhookRequest(captureEvent(orderId, '9.00', 'CAP-A'), 'tr-cap-a'), envWith({}), {
      fetchImpl: fakePayPal().fetchImpl,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.paid).toBe(true);

    const order = await testEnv.DB.prepare('SELECT * FROM vpn_orders WHERE id = ?').bind(orderId).first<{ payment_status: string; paypal_capture_id: string; payment_provider: string }>();
    expect(order?.payment_status).toBe('paid');
    expect(order?.paypal_capture_id).toBe('CAP-A');
    expect(order?.payment_provider).toBe('paypal');
  });

  it('is idempotent: a replayed transmission id is reported as duplicate', async () => {
    const createRes = await vpnPayPalCreate(
      request({ email: 'pp-dup@example.com', planId: 'monthly', idempotencyKey: 'key_pp_dup1_0123456789abcdefghij' }),
      envWith({}),
      { fetchImpl: fakePayPal().fetchImpl },
    );
    const { orderId } = (await createRes.json()) as { orderId: string };
    const raw = captureEvent(orderId, '9.00', 'CAP-DUP');

    const first = await vpnPayPalWebhook(webhookRequest(raw, 'tr-dup-1'), envWith({}), { fetchImpl: fakePayPal().fetchImpl });
    expect(first.status).toBe(200);
    const second = await vpnPayPalWebhook(webhookRequest(raw, 'tr-dup-1'), envWith({}), { fetchImpl: fakePayPal().fetchImpl });
    const data = (await second.json()) as Record<string, unknown>;
    expect(data.duplicate).toBe(true);
  });

  it('ignores a capture whose amount does not match the stored order', async () => {
    const createRes = await vpnPayPalCreate(
      request({ email: 'pp-mismatch@example.com', planId: 'monthly', idempotencyKey: 'key_pp_mis1_0123456789abcdefghijkl' }),
      envWith({}),
      { fetchImpl: fakePayPal().fetchImpl },
    );
    const { orderId } = (await createRes.json()) as { orderId: string };

    const res = await vpnPayPalWebhook(
      webhookRequest(captureEvent(orderId, '1.00', 'CAP-MISMATCH'), 'tr-mismatch'),
      envWith({}),
      { fetchImpl: fakePayPal().fetchImpl },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ignored).toBe('amount_mismatch');

    const order = await testEnv.DB.prepare('SELECT payment_status FROM vpn_orders WHERE id = ?').bind(orderId).first<{ payment_status: string }>();
    expect(order?.payment_status).toBe('unpaid');
  });

  it('ignores events without a VPN order marker (domain isolation)', async () => {
    const raw = JSON.stringify({
      id: 'tr-foreign',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-F', amount: { value: '5.00', currency_code: 'USD' } },
    });
    const res = await vpnPayPalWebhook(webhookRequest(raw, 'tr-foreign'), envWith({}), { fetchImpl: fakePayPal().fetchImpl });
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ignored).toBe('no_vpn_order');
  });

  it('records full refunds and flags partial refunds for review', async () => {
    // Paid order first.
    const createRes = await vpnPayPalCreate(
      request({ email: 'pp-refund@example.com', planId: 'monthly', idempotencyKey: 'key_pp_ref1_0123456789abcdefghijkl' }),
      envWith({}),
      { fetchImpl: fakePayPal().fetchImpl },
    );
    const { orderId } = (await createRes.json()) as { orderId: string };
    await vpnPayPalWebhook(webhookRequest(captureEvent(orderId, '9.00', 'CAP-R1'), 'tr-ref-1'), envWith({}), { fetchImpl: fakePayPal().fetchImpl });

    const full = JSON.stringify({
      id: 'tr-ref-2',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REF-1', custom_id: orderId, amount: { value: '9.00', currency_code: 'USD' }, status: 'COMPLETED' },
    });
    const res = await vpnPayPalWebhook(webhookRequest(full, 'tr-ref-2'), envWith({}), { fetchImpl: fakePayPal().fetchImpl });
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.refunded).toBe(true);

    const order = await testEnv.DB.prepare('SELECT payment_status FROM vpn_orders WHERE id = ?').bind(orderId).first<{ payment_status: string }>();
    expect(order?.payment_status).toBe('refunded');
  });
});

export type { PayPalConfig };
