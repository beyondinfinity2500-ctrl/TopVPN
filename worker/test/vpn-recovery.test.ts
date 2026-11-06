import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, testEnv } from './helpers';
import { classifyRecovery, MAX_PROVISIONING_ATTEMPTS, recoverVpnOrder } from '../vpn/recovery';
import type { VpnProvider } from '../vpn/service';
import { getVpnOrder, insertVpnOrder, markVpnPaid, markVpnRefunded } from '../vpn/repo';
import { provisioningUsername } from '../provisioning';

const NOW = new Date('2026-10-27T10:00:00.000Z');

function fakeProvider(counter: { create: number }): VpnProvider {
  let id = 7000;
  return {
    async createAccount(input) {
      counter.create++;
      return { ok: true, status: 201, data: { id: id++, username: input.username, status: 'Active', expire_at: null } };
    },
    async setExpiry(_id, expireAt) {
      return { ok: true, status: 200, data: { id: 7000, username: 'u', status: 'Active', expire_at: expireAt } };
    },
    async checkUsername() {
      return { ok: true, status: 200, data: { code: 200 } };
    },
    async listAccounts() {
      return { ok: true, status: 200, data: [] };
    },
  };
}

async function seed(paid = true): Promise<string> {
  const id = `ORD-VPN-${crypto.randomUUID()}`;
  const now = NOW.toISOString();
  await insertVpnOrder(testEnv.DB, {
    id,
    customerEmail: 'recovery@example.com',
    customerName: null,
    planId: 'monthly',
    intervalMonths: 1,
    amountCents: 900,
    currency: 'USD',
    providerUsername: provisioningUsername(id),
    now,
  });
  if (paid) await markVpnPaid(testEnv.DB, id, { now });
  return id;
}

beforeAll(async () => {
  await applyMigrations();
});

describe('classifyRecovery', () => {
  const base = { failure_reason: null, updated_at: NOW.toISOString() };

  it('provisions a paid order', () => {
    expect(classifyRecovery({ ...base, order_status: 'paid' }, 0, NOW)).toEqual({
      action: 'provision',
      reason: 'paid',
    });
  });

  it('reconciles (never re-creates) an ambiguous order', () => {
    expect(classifyRecovery({ ...base, order_status: 'reconciliation_required' }, 1, NOW).action).toBe('reconcile');
  });

  it('waits for fresh in-progress orders and reconciles stale ones', () => {
    expect(classifyRecovery({ ...base, order_status: 'provisioning' }, 1, NOW).action).toBe('wait');
    const stale = new Date(NOW.getTime() - 16 * 60_000).toISOString();
    expect(
      classifyRecovery({ ...base, order_status: 'provisioning', updated_at: stale }, 1, NOW).action,
    ).toBe('reconcile');
  });

  it('retries a definitive failure and reconciles a possible existing account', () => {
    expect(
      classifyRecovery({ ...base, order_status: 'provisioning_failed', failure_reason: 'provider_insufficient_balance' }, 1, NOW)
        .action,
    ).toBe('provision');
    expect(
      classifyRecovery({ ...base, order_status: 'provisioning_failed', failure_reason: 'provider_validation' }, 1, NOW)
        .action,
    ).toBe('reconcile');
  });

  it('stops at the attempt limit and ignores terminal states', () => {
    expect(
      classifyRecovery({ ...base, order_status: 'provisioning_failed' }, MAX_PROVISIONING_ATTEMPTS, NOW).action,
    ).toBe('manual_review');
    expect(classifyRecovery({ ...base, order_status: 'active' }, 0, NOW).action).toBe('none');
    expect(classifyRecovery({ ...base, order_status: 'refunded' }, 0, NOW).action).toBe('none');
  });
});

describe('recoverVpnOrder', () => {
  it('provisions a recoverable paid order through the single service path', async () => {
    const id = await seed(true);
    const counter = { create: 0 };
    const result = await recoverVpnOrder(testEnv, id, {
      provider: fakeProvider(counter),
      password: 'test-password',
      now: NOW,
    });

    expect(result.status).toBe('provisioned');
    if (result.status === 'provisioned') expect(result.result.status).toBe('activated');
    expect(counter.create).toBe(1);
    expect((await getVpnOrder(testEnv.DB, id))!.order_status).toBe('active');
  });

  it('refuses to retry after the attempt limit', async () => {
    const id = await seed(true);
    await testEnv.DB.prepare(`UPDATE vpn_orders SET provisioning_attempts = ? WHERE id = ?`)
      .bind(MAX_PROVISIONING_ATTEMPTS, id)
      .run();
    const counter = { create: 0 };
    const result = await recoverVpnOrder(testEnv, id, {
      provider: fakeProvider(counter),
      password: 'p',
      now: NOW,
    });

    expect(result.status).toBe('manual_review');
    expect(counter.create).toBe(0);
  });

  it('never recovers refunded orders', async () => {
    const id = await seed(true);
    await markVpnRefunded(testEnv.DB, id, NOW.toISOString());
    const counter = { create: 0 };
    const result = await recoverVpnOrder(testEnv, id, {
      provider: fakeProvider(counter),
      password: 'p',
      now: NOW,
    });

    expect(result.status).toBe('not_recoverable');
    expect(counter.create).toBe(0);
  });
});
