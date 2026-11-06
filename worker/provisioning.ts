/**
 * VPN account provisioning decisions — pure logic + one tiny D1 claim helper.
 *
 * Keeping this separate makes the things that must never go wrong testable
 * without a network:
 *   1. never provision before a verified successful payment;
 *   2. never provision the same order twice (duplicate webhooks, retries).
 *
 * Concurrency note: `decideProvisioning` is a *decision*, not a lock. The
 * webhook path MUST call `claimProvisioning()` first; the unique key in
 * `vpn_provisioning_claims` is what stops two racing webhooks from both
 * creating a provider account.
 */

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'refunded';
export type ProvisioningState = 'idle' | 'in_progress' | 'done' | 'failed';
export type ProvisioningAction = 'provision' | 'skip' | 'reconcile';

export interface ProvisioningDecisionInput {
  paymentStatus: PaymentStatus;
  /** Provider account id already stored for this order, if any. */
  providerAccountId: string | null;
  provisioningState?: ProvisioningState;
}

/**
 * Decide what to do when a payment event arrives.
 * - `provision`: paid, no provider account yet, and not already in flight.
 * - `reconcile`: a previous attempt failed or finished without persisting the
 *   account id — a check is needed before retrying, so the paid order is never
 *   lost and a second account is never charged.
 * - `skip`: not paid, already provisioned, or another attempt is in flight.
 */
export function decideProvisioning(input: ProvisioningDecisionInput): ProvisioningAction {
  if (input.paymentStatus !== 'paid') return 'skip';
  if (input.providerAccountId) return 'skip';
  if (input.provisioningState === 'in_progress') return 'skip';
  // Provider created but the id was never stored (crash window): reconcile by
  // username before creating anything else.
  if (input.provisioningState === 'done') return 'reconcile';
  if (input.provisioningState === 'failed') return 'reconcile';
  return 'provision';
}

/**
 * Stable key for a provisioning attempt. Two webhooks for the same order map to
 * the same key; the DB unique constraint makes the second insert fail, which is
 * how the race is stopped.
 */
export function provisioningIdempotencyKey(orderId: string): string {
  const trimmed = (orderId ?? '').trim();
  if (!trimmed) throw new Error('provisioningIdempotencyKey: orderId is required');
  return `vpn-provision:${trimmed}`;
}

/**
 * Deterministic provider username for an order. Deterministic names make
 * reconciliation possible: after a timeout we can look the username up instead
 * of creating a second account. Matches the provider's allowed charset and the
 * 3–50 character limit.
 */
export function provisioningUsername(orderId: string): string {
  const cleaned = (orderId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 40);
  return `topvpn-${cleaned || 'account'}`.slice(0, 50);
}

/* ---------- D1 claim (unique key gate) ---------- */

export const PROVISIONING_CLAIMS_TABLE = 'vpn_provisioning_claims';

export function provisioningClaimSql(): string {
  return `INSERT INTO ${PROVISIONING_CLAIMS_TABLE} (claim_key, order_id, created_at) VALUES (?, ?, ?) ON CONFLICT(claim_key) DO NOTHING`;
}

/** Minimal structural D1 surface so this module stays runtime-agnostic. */
export interface ProvisioningClaimStatement {
  bind(...values: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> };
}
export interface ProvisioningClaimDb {
  prepare(query: string): ProvisioningClaimStatement;
}

export interface ProvisioningClaimResult {
  claimed: boolean;
  key: string;
}

/**
 * Atomically claim the right to provision an order. Returns `claimed: false`
 * when another request already claimed it. Call this BEFORE the provider call.
 */
export async function claimProvisioning(
  db: ProvisioningClaimDb,
  orderId: string,
  nowIso: string = new Date().toISOString(),
): Promise<ProvisioningClaimResult> {
  const key = provisioningIdempotencyKey(orderId);
  const result = await db.prepare(provisioningClaimSql()).bind(key, orderId, nowIso).run();
  return { claimed: (result.meta?.changes ?? 0) === 1, key };
}

/* ---------- Date math ---------- */

const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Add calendar months in UTC and return `YYYY-MM-DD` (the format VPNResellers
 * accepts for `expire_at`). Day-of-month is preserved and clamped to the last
 * valid day, so 2026-01-31 + 1 month is 2026-02-28, not 2026-03-03.
 * Impossible dates (e.g. 2026-02-29) are rejected rather than silently shifted.
 */
export function addMonthsUtc(isoDate: string, months: number): string {
  const match = YMD.exec(isoDate ?? '');
  if (!match) throw new Error('addMonthsUtc: invalid date');
  if (!Number.isInteger(months)) throw new Error('addMonthsUtc: months must be an integer');

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);

  const base = new Date(Date.UTC(year, month, day));
  if (base.getUTCFullYear() !== year || base.getUTCMonth() !== month || base.getUTCDate() !== day) {
    throw new Error('addMonthsUtc: invalid date');
  }

  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);

  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clampedDay))
    .toISOString()
    .slice(0, 10);
}

/** Expiry date for a purchase starting now (or at a supplied start date). */
export function expiryDateFor(start: Date | string, intervalMonths: number): string {
  const startIso = typeof start === 'string' ? start : start.toISOString();
  return addMonthsUtc(startIso, intervalMonths);
}

/** Whole days until expiry. `null` means the provider has no expiry (auto-renew). */
export function daysRemaining(expireAt: string | null, now: Date = new Date()): number | null {
  if (!expireAt) return null;
  const end = new Date(expireAt);
  if (Number.isNaN(end.getTime())) return null;
  const diffMs = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / 86_400_000));
}

export type AccountState = 'active' | 'expiring' | 'expired' | 'disabled' | 'unknown';

/**
 * Map provider status + expiry to a state the portal may show.
 * NOTE: the provider returns a date-only `expire_at` (midnight UTC). Whether an
 * account stays usable through that final day is unverified — confirm with the
 * vendor before showing "expired" on the last day.
 */
export function accountStateFor(
  account: { status: string; expireAt: string | null },
  now: Date = new Date(),
): AccountState {
  if (account.status !== 'Active' && account.status !== 'Disabled') return 'unknown';
  if (account.status === 'Disabled') return 'disabled';

  const days = daysRemaining(account.expireAt, now);
  if (days === null) return 'active'; // no expiry set => provider auto-renewal
  if (days <= 0) return 'expired';
  if (days <= 7) return 'expiring';
  return 'active';
}
