import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, testEnv } from './helpers';
import { getVpnAccount, getVpnOrder, insertVpnOrder, markVpnPaid, markVpnRefunded } from '../vpn/repo';
import { provisioningUsername } from '../provisioning';
import {
  derivePassword,
  provisionVpnOrder,
  reconcileVpnOrder,
  type VpnProvider,
} from '../vpn/service';

const NOW = new Date('2026-10-27T10:00:00.000Z');
const NOW_ISO = NOW.toISOString();

let nextProviderId = 5000;

function fakeProvider(overrides: Partial<VpnProvider> = {}) {
  const calls = { create: 0, expiry: 0, check: 0, list: 0 };
  const provider: VpnProvider = {
    async createAccount(input) {
      calls.create++;
      return {
        ok: true,
        status: 201,
        data: { id: nextProviderId++, username: input.username, status: 'Active', expire_at: null },
      };
    },
    async setExpiry(_id, expireAt) {
      calls.expiry++;
      return { ok: true, status: 200, data: { id: 42, username: 'topvpn-x', status: 'Active', expire_at: expireAt } };
    },
    async checkUsername() {
      calls.check++;
      return { ok: true, status: 200, data: { code: 200 } };
    },
    async listAccounts() {
      calls.list++;
      return { ok: true, status: 200, data: [] };
    },
    ...overrides,
  };
  return { provider, calls };
}

async function newOrder(paid: boolean, plan = 'monthly', amount = 900): Promise<string> {
  const id = `ORD-VPN-${crypto.randomUUID()}`;
  await insertVpnOrder(testEnv.DB, {
    id,
    customerEmail: 'buyer@example.com',
    customerName: null,
    planId: plan,
    intervalMonths: plan === 'annual' ? 12 : plan === 'two-year' ? 24 : 1,
    amountCents: amount,
    currency: 'USD',
    providerUsername: provisioningUsername(id),
    now: NOW_ISO,
  });
  if (paid) await markVpnPaid(testEnv.DB, id, { now: NOW_ISO });
  return id;
}

beforeAll(async () => {
  await applyMigrations();
});

describe('provisionVpnOrder', () => {
  it('refuses unknown and empty order ids', async () => {
    expect((await provisionVpnOrder(testEnv, 'ORD-VPN-missing')).status).toBe('not_found');
    expect((await provisionVpnOrder(testEnv, '   ')).status).toBe('not_found');
  });

  it('never provisions an unpaid or refunded order', async () => {
    const unpaid = await newOrder(false);
    expect((await provisionVpnOrder(testEnv, unpaid, { provider: fakeProvider().provider })).status).toBe('not_paid');

    const refunded = await newOrder(true);
    await markVpnRefunded(testEnv.DB, refunded, NOW_ISO);
    expect((await provisionVpnOrder(testEnv, refunded, { provider: fakeProvider().provider })).status).toBe('not_paid');
  });

  it('activates a paid order and stores the provider account + expiry', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider();

    const result = await provisionVpnOrder(testEnv, id, { provider, password: 'test-password', now: NOW });
    expect(result.status).toBe('activated');
    expect(calls.create).toBe(1);
    expect(calls.expiry).toBe(1);

    const order = await getVpnOrder(testEnv.DB, id);
    expect(order!.order_status).toBe('active');
    expect(order!.provisioning_status).toBe('succeeded');
    expect(order!.subscription_status).toBe('active');
    expect(order!.expire_at).toBe('2026-11-27');
    expect(order!.provisioning_attempts).toBe(1);

    const account = await getVpnAccount(testEnv.DB, id);
    if (result.status === 'activated') {
      expect(order!.provider_account_id).toBe(String(result.accountId));
      expect(account!.provider_account_id).toBe(String(result.accountId));
    }
  });

  it('does not provision twice on a retry', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider();

    await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    const second = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });

    expect(second.status).toBe('already_provisioned');
    expect(calls.create).toBe(1);
  });

  it('creates exactly one account when two requests race', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider();

    const results = await Promise.all([
      provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW }),
      provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW }),
    ]);
    expect(results.filter((r) => r.status === 'activated')).toHaveLength(1);
    expect(calls.create).toBe(1);
  });

  it('treats a create timeout as ambiguous and never retries it', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider({
      async createAccount() {
        calls.create++;
        return { ok: false, status: 0, error: { kind: 'timeout', message: 'Provider request timed out' } };
      },
    });

    const first = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    expect(first.status).toBe('reconciliation_required');

    const order = await getVpnOrder(testEnv.DB, id);
    expect(order!.order_status).toBe('reconciliation_required');
    expect(order!.provisioning_status).toBe('reconciliation');
    expect(order!.payment_status).toBe('paid'); // the payment is never lost

    const second = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    expect(second).toMatchObject({ status: 'skipped', reason: 'order_status_reconciliation_required' });
    expect(calls.create).toBe(1);
  });

  it('treats a provider 5xx during create as ambiguous and never retries it', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider({
      async createAccount() {
        calls.create++;
        return { ok: false, status: 502, error: { kind: 'server', message: 'Bad gateway' } };
      },
    });

    const first = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    expect(first).toMatchObject({ status: 'reconciliation_required', reason: 'create_ambiguous' });

    const order = await getVpnOrder(testEnv.DB, id);
    expect(order!.order_status).toBe('reconciliation_required');
    expect(order!.payment_status).toBe('paid');

    const second = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    expect(second.status).toBe('skipped');
    expect(calls.create).toBe(1);
  });

  it('records a definite provider failure without losing the paid order, and allows a safe retry', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider({
      async createAccount() {
        calls.create++;
        return { ok: false, status: 402, error: { kind: 'insufficient_balance', message: 'Insufficient Balance.' } };
      },
    });

    const result = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    expect(result).toMatchObject({ status: 'provisioning_failed', reason: 'provider_insufficient_balance' });

    const order = await getVpnOrder(testEnv.DB, id);
    expect(order!.order_status).toBe('provisioning_failed');
    expect(order!.payment_status).toBe('paid');
    expect(order!.failure_reason).toBe('provider_insufficient_balance');

    // A definite failure releases the claim, so a later retry is possible.
    const retry = await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    expect(retry.status).toBe('provisioning_failed');
    expect(calls.create).toBe(2);
  });

  it('fails safely when the provider or the password secret is missing', async () => {
    const id = await newOrder(true);
    const noProvider = await provisionVpnOrder(testEnv, id, { provider: null, password: 'p', now: NOW });
    expect(noProvider).toMatchObject({ status: 'provisioning_failed', reason: 'provider_not_configured' });

    const id2 = await newOrder(true);
    const envNoSecret = { DB: testEnv.DB } as unknown as Env;
    const { provider } = fakeProvider();
    const noSecret = await provisionVpnOrder(envNoSecret, id2, { provider, now: NOW });
    expect(noSecret).toMatchObject({ status: 'provisioning_failed', reason: 'provisioning_secret_not_configured' });
    expect((await getVpnOrder(testEnv.DB, id2))!.payment_status).toBe('paid');
  });
});

describe('reconcileVpnOrder', () => {
  it('finds an existing account by its deterministic username and activates the order', async () => {
    const id = await newOrder(true);
    const order = await getVpnOrder(testEnv.DB, id);
    const username = order!.provider_username!;

    const { provider, calls } = fakeProvider({
      async checkUsername() {
        calls.check++;
        return { ok: false, status: 422, error: { kind: 'validation', message: 'The username has already been taken.' } };
      },
      async listAccounts() {
        calls.list++;
        return {
          ok: true,
          status: 200,
          data: [{ id: 77, username, status: 'Active', expire_at: '2027-01-01T00:00:00.000000Z' }],
        };
      },
    });

    // Put the order into a reconcilable state first.
    await provisionVpnOrder(testEnv, id, {
      provider: fakeProvider({
        async createAccount() {
          return { ok: false, status: 0, error: { kind: 'timeout', message: 'timeout' } };
        },
      }).provider,
      password: 'p',
      now: NOW,
    });

    const result = await reconcileVpnOrder(testEnv, id, { provider, now: NOW });
    expect(result.status).toBe('activated');
    expect(calls.create).toBe(0); // reconciliation never creates

    const updated = await getVpnOrder(testEnv.DB, id);
    expect(updated!.order_status).toBe('active');
    expect(updated!.provider_account_id).toBe('77');
  });

  it('reports a still-missing account without creating one', async () => {
    const id = await newOrder(true);
    const { provider, calls } = fakeProvider({
      async createAccount() {
        calls.create++;
        return { ok: false, status: 0, error: { kind: 'timeout', message: 'timeout' } };
      },
    });

    await provisionVpnOrder(testEnv, id, { provider, password: 'p', now: NOW });
    const result = await reconcileVpnOrder(testEnv, id, { provider: fakeProvider().provider, now: NOW });

    expect(result).toMatchObject({ status: 'still_missing', reason: 'provider_account_not_found' });
    expect(calls.create).toBe(1);
  });

  it('refuses to reconcile an order that is not in a failed state', async () => {
    const id = await newOrder(true);
    await markVpnRefunded(testEnv.DB, id, NOW_ISO);
    const result = await reconcileVpnOrder(testEnv, id, { provider: fakeProvider().provider, now: NOW });
    expect(result).toMatchObject({ status: 'not_reconcilable', orderStatus: 'refunded' });
  });
});

describe('derivePassword', () => {
  it('is deterministic per order and never returns the raw secret', async () => {
    const a = await derivePassword('server-secret', 'ORD-VPN-1');
    const b = await derivePassword('server-secret', 'ORD-VPN-1');
    const c = await derivePassword('server-secret', 'ORD-VPN-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('server-secret');
  });
});
