import { describe, expect, it } from 'vitest';
import {
  accountStateFor,
  addMonthsUtc,
  claimProvisioning,
  daysRemaining,
  decideProvisioning,
  expiryDateFor,
  provisioningClaimSql,
  provisioningIdempotencyKey,
  provisioningUsername,
  type ProvisioningClaimDb,
} from '../provisioning';

describe('provisioning decisions', () => {
  it('never provisions before a verified successful payment', () => {
    for (const status of ['pending', 'failed', 'expired', 'cancelled', 'refunded'] as const) {
      expect(
        decideProvisioning({ paymentStatus: status, providerAccountId: null, provisioningState: 'idle' }),
      ).toBe('skip');
    }
  });

  it('provisions once for a paid order with no provider account', () => {
    expect(
      decideProvisioning({ paymentStatus: 'paid', providerAccountId: null, provisioningState: 'idle' }),
    ).toBe('provision');
  });

  it('is idempotent: an already provisioned order is skipped', () => {
    expect(
      decideProvisioning({ paymentStatus: 'paid', providerAccountId: '12345', provisioningState: 'done' }),
    ).toBe('skip');
  });

  it('does not start a second attempt while one is in flight', () => {
    expect(
      decideProvisioning({ paymentStatus: 'paid', providerAccountId: null, provisioningState: 'in_progress' }),
    ).toBe('skip');
  });

  it('reconciles a done order whose account id was never persisted', () => {
    expect(
      decideProvisioning({ paymentStatus: 'paid', providerAccountId: null, provisioningState: 'done' }),
    ).toBe('reconcile');
  });

  it('routes failed attempts to reconciliation instead of blind retry', () => {
    expect(
      decideProvisioning({ paymentStatus: 'paid', providerAccountId: null, provisioningState: 'failed' }),
    ).toBe('reconcile');
  });

  it('derives a stable idempotency key per order', () => {
    expect(provisioningIdempotencyKey('ORD-abc')).toBe('vpn-provision:ORD-abc');
    expect(provisioningIdempotencyKey('ORD-abc')).toBe(provisioningIdempotencyKey('ORD-abc'));
    expect(provisioningIdempotencyKey('ORD-abc')).not.toBe(provisioningIdempotencyKey('ORD-def'));
  });

  it('refuses an empty order id instead of sharing one key', () => {
    expect(() => provisioningIdempotencyKey('')).toThrow();
    expect(() => provisioningIdempotencyKey('   ')).toThrow();
    expect(() => provisioningIdempotencyKey(null as unknown as string)).toThrow();
  });
});

describe('deterministic provider usernames', () => {
  it('is stable for the same order', () => {
    expect(provisioningUsername('ORD-abc')).toBe(provisioningUsername('ORD-abc'));
    expect(provisioningUsername('ORD-abc')).not.toBe(provisioningUsername('ORD-def'));
  });

  it('uses only the provider-allowed characters and length', () => {
    const username = provisioningUsername('ORD 12/34 & <weird>');
    expect(username).toMatch(/^[a-z0-9._@-]+$/);
    expect(username.length).toBeGreaterThanOrEqual(3);
    expect(username.length).toBeLessThanOrEqual(50);
    expect(username.startsWith('topvpn-')).toBe(true);
  });

  it('still produces a valid name for an odd id', () => {
    expect(provisioningUsername('///')).toMatch(/^[a-z0-9._@-]{3,50}$/);
  });
});

describe('provisioning claim (unique-key gate)', () => {
  function fakeDb(changes: number[]) {
    const calls: unknown[][] = [];
    let index = 0;
    const db = {
      prepare(_query: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                calls.push(values);
                const value = changes[index] ?? 0;
                index++;
                return { meta: { changes: value } };
              },
            };
          },
        };
      },
    };
    return { db: db as unknown as ProvisioningClaimDb, calls };
  }

  it('uses an atomic INSERT … ON CONFLICT DO NOTHING', () => {
    expect(provisioningClaimSql()).toContain('ON CONFLICT(claim_key) DO NOTHING');
  });

  it('claims once and refuses the second racing request', async () => {
    const { db, calls } = fakeDb([1, 0]);

    const first = await claimProvisioning(db, 'ORD-1', '2026-10-27T00:00:00.000Z');
    const second = await claimProvisioning(db, 'ORD-1', '2026-10-27T00:00:00.000Z');

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(calls[0]).toEqual(['vpn-provision:ORD-1', 'ORD-1', '2026-10-27T00:00:00.000Z']);
  });
});

describe('date math for provider expiry (YYYY-MM-DD, UTC)', () => {
  it('adds whole months', () => {
    expect(addMonthsUtc('2026-10-27', 1)).toBe('2026-11-27');
    expect(addMonthsUtc('2026-10-27', 12)).toBe('2027-10-27');
    expect(addMonthsUtc('2026-10-27', 24)).toBe('2028-10-27');
  });

  it('clamps to the last valid day instead of overflowing', () => {
    expect(addMonthsUtc('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsUtc('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(addMonthsUtc('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonthsUtc('2026-12-31', 2)).toBe('2027-02-28');
  });

  it('crosses year boundaries', () => {
    expect(addMonthsUtc('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonthsUtc('2027-01-15', -1)).toBe('2026-12-15');
  });

  it('rejects invalid input rather than guessing', () => {
    expect(() => addMonthsUtc('not-a-date', 1)).toThrow();
    expect(() => addMonthsUtc('2026-10-27', 1.5)).toThrow();
    expect(() => addMonthsUtc('2026-02-29', 1)).toThrow(); // 2026 is not a leap year
    expect(() => addMonthsUtc('2026-13-01', 1)).toThrow();
  });

  it('builds an expiry from a start date', () => {
    expect(expiryDateFor('2026-10-27', 1)).toBe('2026-11-27');
    expect(expiryDateFor(new Date('2026-10-27T08:00:00Z'), 12)).toBe('2027-10-27');
  });
});

describe('remaining days and account state', () => {
  const now = new Date('2026-10-27T12:00:00Z');

  it('reports null when the provider has no expiry (auto-renew)', () => {
    expect(daysRemaining(null, now)).toBeNull();
  });

  it('never reports negative days', () => {
    expect(daysRemaining('2026-10-01T00:00:00Z', now)).toBe(0);
  });

  it('counts whole remaining days', () => {
    expect(daysRemaining('2026-10-30T12:00:00Z', now)).toBe(3);
    expect(daysRemaining('2026-10-28T12:00:00Z', now)).toBe(1);
  });

  it('maps provider status and expiry to a portal state', () => {
    expect(accountStateFor({ status: 'Disabled', expireAt: '2027-01-01T00:00:00Z' }, now)).toBe('disabled');
    expect(accountStateFor({ status: 'Active', expireAt: null }, now)).toBe('active');
    expect(accountStateFor({ status: 'Active', expireAt: '2026-10-01T00:00:00Z' }, now)).toBe('expired');
    expect(accountStateFor({ status: 'Active', expireAt: '2026-11-01T00:00:00Z' }, now)).toBe('expiring');
    expect(accountStateFor({ status: 'Active', expireAt: '2027-06-01T00:00:00Z' }, now)).toBe('active');
    expect(accountStateFor({ status: 'Weird', expireAt: null }, now)).toBe('unknown');
  });
});
