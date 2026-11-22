import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, testEnv } from './helpers';
import { insertVpnOrder, expireOverdueVpnOrders, getVpnOrder } from '../vpn/repo';

beforeAll(async () => {
  await applyMigrations();
});

describe('expireOverdueVpnOrders', () => {
  it('marks active orders with past expire_at as expired', async () => {
    const now = new Date().toISOString();
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'expiry@example.com',
      customerName: null,
      planId: 'monthly',
      intervalMonths: 1,
      amountCents: 900,
      currency: 'USD',
      providerUsername: 'topvpn-expiry',
      now,
    });
    await testEnv.DB.prepare(
      `UPDATE vpn_orders SET order_status='active', payment_status='paid', provisioning_status='succeeded',
        provider_account_id='999', expire_at='2020-01-01', payment_mode='live' WHERE id=?`,
    ).bind(id).run();

    const n = await expireOverdueVpnOrders(testEnv.DB, now);
    expect(n).toBeGreaterThanOrEqual(1);

    const row = await getVpnOrder(testEnv.DB, id);
    expect(row?.order_status).toBe('expired');
    expect(row?.subscription_status).toBe('expired');
  });

  it('does not touch active orders with future expiry', async () => {
    const now = new Date().toISOString();
    const id = `ORD-VPN-${crypto.randomUUID()}`;
    await insertVpnOrder(testEnv.DB, {
      id,
      customerEmail: 'future@example.com',
      customerName: null,
      planId: 'monthly',
      intervalMonths: 1,
      amountCents: 900,
      currency: 'USD',
      providerUsername: 'topvpn-future',
      now,
    });
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await testEnv.DB.prepare(
      `UPDATE vpn_orders SET order_status='active', payment_status='paid', provisioning_status='succeeded',
        provider_account_id='998', expire_at=?, payment_mode='live' WHERE id=?`,
    ).bind(future, id).run();

    await expireOverdueVpnOrders(testEnv.DB, now);
    const row = await getVpnOrder(testEnv.DB, id);
    expect(row?.order_status).toBe('active');
  });
});