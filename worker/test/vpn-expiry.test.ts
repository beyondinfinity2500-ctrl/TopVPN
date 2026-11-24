import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrations, testEnv } from './helpers';
import { expireOverdueVpnOrders, getVpnOrder, insertVpnOrder } from '../vpn/repo';
import { sendPendingExpiryWarnings } from '../vpn/notifications';
import type { Env } from '../env';

beforeAll(async () => {
  await applyMigrations();
});

async function seedActiveOrder(email: string, expireAt: string, paymentMode = 'live'): Promise<string> {
  const now = new Date().toISOString();
  const id = `ORD-VPN-${crypto.randomUUID()}`;
  const accountId = String(1000 + Math.floor(Math.random() * 1_000_000));
  await insertVpnOrder(testEnv.DB, {
    id,
    customerEmail: email,
    customerName: null,
    planId: 'monthly',
    intervalMonths: 1,
    amountCents: 900,
    currency: 'USD',
    providerUsername: `topvpn-${id.toLowerCase()}`.slice(0, 50),
    now,
  });
  await testEnv.DB.prepare(
    `UPDATE vpn_orders SET order_status='active', payment_status='paid', provisioning_status='succeeded',
       provider_account_id=?, expire_at=?, payment_mode=? WHERE id=?`,
  )
    .bind(accountId, expireAt, paymentMode, id)
    .run();
  return id;
}

const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const past = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

describe('expireOverdueVpnOrders', () => {
  it('expires past-due active orders and is idempotent', async () => {
    const id = await seedActiveOrder('cron-a@example.com', past(1));
    const n = await expireOverdueVpnOrders(testEnv.DB, new Date().toISOString());
    expect(n).toBeGreaterThanOrEqual(1);
    const row = await getVpnOrder(testEnv.DB, id);
    expect(row?.order_status).toBe('expired');
    expect(row?.subscription_status).toBe('expired');

    // Second run: nothing left to expire for this order.
    const before = row!.version;
    await expireOverdueVpnOrders(testEnv.DB, new Date().toISOString());
    const after = await getVpnOrder(testEnv.DB, id);
    expect(after!.version).toBe(before);
  });

  it('does not touch orders expiring today (end-of-day semantics)', async () => {
    const id = await seedActiveOrder('cron-today@example.com', future(0));
    await expireOverdueVpnOrders(testEnv.DB, new Date().toISOString());
    const row = await getVpnOrder(testEnv.DB, id);
    expect(row?.order_status).toBe('active');
  });

  it('leaves future and pending orders alone', async () => {
    const futureId = await seedActiveOrder('cron-future@example.com', future(20));
    const now = new Date().toISOString();
    const pendingId = `ORD-VPN-${crypto.randomUUID()}`;
    await insertVpnOrder(testEnv.DB, {
      id: pendingId,
      customerEmail: 'cron-pending@example.com',
      customerName: null,
      planId: 'monthly',
      intervalMonths: 1,
      amountCents: 900,
      currency: 'USD',
      providerUsername: `topvpn-${pendingId.toLowerCase()}`.slice(0, 50),
      now,
    });
    await testEnv.DB.prepare(`UPDATE vpn_orders SET expire_at=? WHERE id=?`).bind(past(5), pendingId).run();

    await expireOverdueVpnOrders(testEnv.DB, now);
    expect((await getVpnOrder(testEnv.DB, futureId))?.order_status).toBe('active');
    expect((await getVpnOrder(testEnv.DB, pendingId))?.order_status).toBe('pending_payment');
  });
});

describe('sendPendingExpiryWarnings', () => {
  it('is a no-op without RESEND_API_KEY', async () => {
    const env = { DB: testEnv.DB } as unknown as Env;
    const sent = await sendPendingExpiryWarnings(env, 7);
    expect(sent).toBe(0);
  });

  it('sends once and dedups within the warning window', async () => {
    const id = await seedActiveOrder('warn-dedup@example.com', future(3));
    // Intercept outbound email so no real request leaves the test runtime.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const env = {
      DB: testEnv.DB,
      RESEND_API_KEY: 're_test_key',
      SITE_URL: 'https://www.topvpn.top',
      CUSTOMER_EMAIL_FROM: 'TopVPN Accounts <accounts@topvpn.top>',
    } as unknown as Env;

    const first = await sendPendingExpiryWarnings(env, 7);
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await sendPendingExpiryWarnings(env, 7);
    expect(second).toBe(0);

    const events = await testEnv.DB.prepare(
      `SELECT reason FROM vpn_order_events WHERE order_id=? AND reason LIKE 'expiry_warning_%'`,
    )
      .bind(id)
      .all<{ reason: string }>();
    expect(events.results!.length).toBe(1);
    expect(events.results![0].reason).toBe('expiry_warning_sent');
    vi.unstubAllGlobals();
  });

  it('does not warn on an already-expired order', async () => {
    const id = await seedActiveOrder('warn-expired@example.com', past(2));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await testEnv.DB.prepare(`UPDATE vpn_orders SET order_status='expired', subscription_status='expired' WHERE id=?`)
      .bind(id)
      .run();
    const env = { DB: testEnv.DB, RESEND_API_KEY: 're_test_key' } as unknown as Env;
    const sent = await sendPendingExpiryWarnings(env, 7);
    expect(sent).toBe(0);
    vi.unstubAllGlobals();
  });
});