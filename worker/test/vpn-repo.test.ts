import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, createOrder as createAdOrder, testEnv } from './helpers';
import { getOrder } from '../db';
import {
  claimVpnProvisioning,
  getVpnAccount,
  getVpnOrder,
  getVpnOrderBySession,
  hasPriorPaidVpnOrder,
  insertVpnOrder,
  markVpnPaid,
  markVpnPaymentEventProcessed,
  markVpnRefunded,
  recordVpnPaymentEvent,
  saveVpnAccount,
  transitionVpnOrder,
} from '../vpn/repo';
import { provisioningUsername } from '../provisioning';

const NOW = '2026-10-27T10:00:00.000Z';

async function newOrder(email = 'buyer@example.com', plan = 'monthly', amount = 900): Promise<string> {
  const id = `ORD-VPN-${crypto.randomUUID()}`;
  await insertVpnOrder(testEnv.DB, {
    id,
    customerEmail: email,
    customerName: null,
    planId: plan,
    intervalMonths: plan === 'annual' ? 12 : plan === 'two-year' ? 24 : 1,
    amountCents: amount,
    currency: 'USD',
    providerUsername: provisioningUsername(id),
    now: NOW,
  });
  return id;
}

beforeAll(async () => {
  await applyMigrations();
});

describe('VPN order repository', () => {
  it('stores and reads an order with all four state dimensions', async () => {
    const id = await newOrder();
    const order = await getVpnOrder(testEnv.DB, id);
    expect(order).not.toBeNull();
    expect(order!.order_status).toBe('pending_payment');
    expect(order!.payment_status).toBe('unpaid');
    expect(order!.provisioning_status).toBe('none');
    expect(order!.subscription_status).toBe('none');
    expect(order!.amount_cents).toBe(900);
    expect(order!.currency).toBe('USD');
  });

  it('marks paid exactly once, even if called twice', async () => {
    const id = await newOrder();
    const first = await markVpnPaid(testEnv.DB, id, { sessionId: 'cs_1', paymentIntent: 'pi_1', now: NOW });
    const second = await markVpnPaid(testEnv.DB, id, { sessionId: 'cs_1', now: NOW });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const order = await getVpnOrder(testEnv.DB, id);
    expect(order!.order_status).toBe('paid');
    expect(order!.payment_status).toBe('paid');
    expect(order!.paid_at).toBe(NOW);
    expect(await getVpnOrderBySession(testEnv.DB, 'cs_1')).not.toBeNull();
  });

  it('refunds a paid order once and never revives it', async () => {
    const id = await newOrder();
    await markVpnPaid(testEnv.DB, id, { now: NOW });
    const first = await markVpnRefunded(testEnv.DB, id, NOW);
    const second = await markVpnRefunded(testEnv.DB, id, NOW);
    expect(first).toBe(true);
    expect(second).toBe(false);
    const order = await getVpnOrder(testEnv.DB, id);
    expect(order!.order_status).toBe('refunded');
    expect(order!.payment_status).toBe('refunded');
  });

  it('refuses to transition from the wrong current state (optimistic)', async () => {
    const id = await newOrder();
    expect(await transitionVpnOrder(testEnv.DB, id, 'pending_payment', 'paid', {}, 'x', NOW)).toBe(true);
    expect(await transitionVpnOrder(testEnv.DB, id, 'pending_payment', 'paid', {}, 'x', NOW)).toBe(false);
  });

  it('allows retrying an unprocessed event but not a processed one', async () => {
    const id = await newOrder();
    const event = {
      eventId: `evt_${crypto.randomUUID()}`,
      orderId: id,
      eventType: 'checkout.session.completed',
      amountCents: 900,
      currency: 'USD',
      now: NOW,
    };
    expect(await recordVpnPaymentEvent(testEnv.DB, event)).toBe(true);
    // Crash window: the row exists but was never processed → retry is allowed.
    expect(await recordVpnPaymentEvent(testEnv.DB, event)).toBe(true);
    await markVpnPaymentEventProcessed(testEnv.DB, event.eventId, NOW);
    expect(await recordVpnPaymentEvent(testEnv.DB, event)).toBe(false);
  });

  it('claims provisioning exactly once under concurrency', async () => {
    const id = await newOrder();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimVpnProvisioning(testEnv.DB, id, NOW)),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('stores one provider account per order and refuses overwrites', async () => {
    const id = await newOrder();
    const base = { orderId: id, providerAccountId: '1001', username: 'topvpn-abc', expireAt: null, now: NOW };
    expect(await saveVpnAccount(testEnv.DB, base)).toBe(true);
    expect(await saveVpnAccount(testEnv.DB, { ...base, providerAccountId: '1002' })).toBe(false);
    const account = await getVpnAccount(testEnv.DB, id);
    expect(account!.provider_account_id).toBe('1001');
  });

  it('rejects two orders sharing a stripe_session_id at the database level', async () => {
    const a = await newOrder();
    const b = await newOrder();
    await testEnv.DB.prepare(`UPDATE vpn_orders SET stripe_session_id = ? WHERE id = ?`)
      .bind('cs_repo_unique', a)
      .run();
    await expect(
      testEnv.DB.prepare(`UPDATE vpn_orders SET stripe_session_id = ? WHERE id = ?`)
        .bind('cs_repo_unique', b)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('detects a prior paid order case-insensitively for intro eligibility', async () => {
    const email = `intro-${crypto.randomUUID()}@example.com`;
    const id = await newOrder(email);
    expect(await hasPriorPaidVpnOrder(testEnv.DB, email.toUpperCase())).toBe(false);
    await markVpnPaid(testEnv.DB, id, { now: NOW });
    expect(await hasPriorPaidVpnOrder(testEnv.DB, email.toUpperCase())).toBe(true);
  });

  it('keeps advertising and VPN orders completely isolated', async () => {
    const ad = await createAdOrder({}, `10.99.0.${Math.floor(Math.random() * 200) + 1}`);
    expect(ad.orderId).toMatch(/^ORD-/);
    expect(await getVpnOrder(testEnv.DB, ad.orderId)).toBeNull();

    const vpnId = await newOrder();
    expect(await getOrder(testEnv.DB, vpnId)).toBeNull();
    expect(await getOrder(testEnv.DB, ad.orderId)).not.toBeNull();
  });
});
