/**
 * VPN order service — the single orchestration path for creating orders and
 * provisioning accounts. No route may call the provider directly.
 *
 * Payment and provisioning are deliberately separate: a paid order can be
 * `provisioning_failed` or `reconciliation_required` without losing the payment.
 */
import type { Env } from '../env';
import { orderAmountCents, getPlan, isPlanId, type PlanId } from '../../src/lib/plans';
import { expiryDateFor, provisioningUsername } from '../provisioning';
import {
  loadVpnResellersConfig,
  VpnResellersClient,
  type ProviderAccount,
  type ProviderResult,
} from '../vpnresellers';
import {
  claimVpnProvisioning,
  getVpnAccount,
  getVpnOrder,
  incrementVpnProvisioningAttempts,
  insertVpnOrder,
  markVpnPaymentEventProcessed,
  recordVpnOrderEvent,
  releaseVpnProvisioningClaim,
  saveVpnAccount,
  transitionVpnOrder,
  type VpnOrderRow,
} from './repo';

/** Narrow provider surface; `VpnResellersClient` satisfies it structurally. */
export interface VpnProvider {
  createAccount(input: { username: string; password: string }): Promise<ProviderResult<ProviderAccount>>;
  checkUsername(username: string): Promise<ProviderResult<{ message?: string; code?: number }>>;
  listAccounts(
    page?: number,
    perPage?: number,
    status?: 'Active' | 'Disabled',
  ): Promise<ProviderResult<ProviderAccount[]>>;
  setExpiry(id: number, expireAt: string | null): Promise<ProviderResult<ProviderAccount>>;
}

export interface ProvisioningDeps {
  provider?: VpnProvider | null;
  /** Injected in tests; production derives it from a server secret. */
  password?: string;
  now?: Date;
}

export type ProvisionOutcome =
  | { status: 'not_found' }
  | { status: 'not_paid' }
  | { status: 'already_provisioned' }
  | { status: 'claim_exists' }
  | { status: 'skipped'; reason: string }
  | { status: 'activated'; accountId: number }
  | { status: 'reconciliation_required'; reason: string }
  | { status: 'provisioning_failed'; reason: string };

const enc = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Deterministic account password derived from a server secret. Nothing is
 * stored at rest, and the same order can be reconciled without a password.
 * `shortcut: rotating VPN_PROVISIONING_SECRET changes future derivations; add a
 * stored key-version column before rotation is needed.`
 */
export async function derivePassword(secret: string, orderId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`vpn-password:${orderId}`)),
  );
  return base64Url(signature).slice(0, 32);
}

function providerFromEnv(env: Env): VpnProvider | null {
  const config = loadVpnResellersConfig(env);
  if (!config.ok) return null;
  return new VpnResellersClient(config.config);
}

export interface CreateVpnOrderInput {
  email: string;
  name?: string | null;
  planId: string;
  introEligible: boolean;
  idempotencyKey?: string | null;
  now?: Date;
}

export async function createVpnOrder(env: Env, input: CreateVpnOrderInput): Promise<VpnOrderRow> {
  if (!isPlanId(input.planId)) throw new Error('createVpnOrder: invalid plan id');
  const planId: PlanId = input.planId;
  const plan = getPlan(planId);
  const now = (input.now ?? new Date()).toISOString();
  const id = `ORD-VPN-${crypto.randomUUID()}`;

  await insertVpnOrder(env.DB, {
    id,
    customerEmail: input.email.trim().toLowerCase(),
    customerName: input.name?.trim() || null,
    planId,
    intervalMonths: plan.intervalMonths,
    amountCents: orderAmountCents(planId, { introEligible: input.introEligible }),
    currency: 'USD',
    providerUsername: provisioningUsername(id),
    idempotencyKey: input.idempotencyKey ?? null,
    now,
  });

  const order = await getVpnOrder(env.DB, id);
  if (!order) throw new Error('createVpnOrder: insert failed');
  return order;
}

async function markFailed(env: Env, order: VpnOrderRow, reason: string, now: string): Promise<ProvisionOutcome> {
  if (order.order_status === 'provisioning') {
    await transitionVpnOrder(
      env.DB,
      order.id,
      'provisioning',
      'provisioning_failed',
      { provisioningStatus: 'failed', failureReason: reason },
      reason,
      now,
    );
  } else {
    // Already in a failed/reconciliation state: record the attempt without a
    // self-transition (which the state machine rejects).
    await env.DB
      .prepare(
        `UPDATE vpn_orders SET provisioning_status = 'failed', failure_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .bind(reason, now, order.id)
      .run();
    await recordVpnOrderEvent(env.DB, {
      orderId: order.id,
      from: order.order_status,
      to: order.order_status,
      reason,
      now,
    });
  }
  // A definite failure means no provider account was created, so the claim can
  // be released safely; a later retry (after config/top-up) is then allowed.
  await releaseVpnProvisioningClaim(env.DB, order.id);
  return { status: 'provisioning_failed', reason };
}

async function markReconciliation(
  env: Env,
  order: VpnOrderRow,
  reason: string,
  now: string,
  patch: { providerAccountId?: string; expireAt?: string | null } = {},
): Promise<ProvisionOutcome> {
  try {
    if (order.order_status === 'provisioning') {
      await transitionVpnOrder(
        env.DB,
        order.id,
        'provisioning',
        'reconciliation_required',
        { provisioningStatus: 'reconciliation', failureReason: reason, ...patch },
        reason,
        now,
      );
    } else {
      await env.DB
        .prepare(
          `UPDATE vpn_orders SET provisioning_status = 'reconciliation', failure_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .bind(reason, now, order.id)
        .run();
      await recordVpnOrderEvent(env.DB, {
        orderId: order.id,
        from: order.order_status,
        to: order.order_status,
        reason,
        now,
      });
    }
    return { status: 'reconciliation_required', reason };
  } catch {
    // A unique conflict on the provider id must not strand a paid order.
    await env.DB
      .prepare(
        `UPDATE vpn_orders SET provisioning_status = 'reconciliation', failure_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .bind(`${reason}_mapping_conflict`, now, order.id)
      .run();
    return { status: 'reconciliation_required', reason: `${reason}_mapping_conflict` };
  }
}

/**
 * The only function allowed to create a provider account.
 * Outcomes are explicit; an ambiguous create is never retried automatically.
 */
export async function provisionVpnOrder(
  env: Env,
  orderId: string,
  deps: ProvisioningDeps = {},
): Promise<ProvisionOutcome> {
  if (!orderId || !orderId.trim()) return { status: 'not_found' };
  const now = (deps.now ?? new Date()).toISOString();

  const order = await getVpnOrder(env.DB, orderId);
  if (!order) return { status: 'not_found' };
  if (order.payment_status !== 'paid') return { status: 'not_paid' };
  if (order.provider_account_id) return { status: 'already_provisioned' };

  const from: 'paid' | 'provisioning_failed' | null =
    order.order_status === 'paid'
      ? 'paid'
      : order.order_status === 'provisioning_failed'
        ? 'provisioning_failed'
        : null;
  if (!from) return { status: 'skipped', reason: `order_status_${order.order_status}` };

  const claim = await claimVpnProvisioning(env.DB, order.id, now);
  if (!claim.claimed) return { status: 'claim_exists' };

  const moved = await transitionVpnOrder(
    env.DB,
    order.id,
    from,
    'provisioning',
    { provisioningStatus: 'provisioning' },
    'provisioning_started',
    now,
  );
  if (!moved) {
    const current = await getVpnOrder(env.DB, order.id);
    if (current?.order_status === 'paid') {
      // We won the claim but could not transition (transient DB issue). Release
      // the claim so a Stripe retry can attempt provisioning again.
      await releaseVpnProvisioningClaim(env.DB, order.id);
      return { status: 'skipped', reason: 'transition_failed' };
    }
    return { status: 'skipped', reason: `order_status_${current?.order_status ?? 'unknown'}` };
  }

  const provider = deps.provider === undefined ? providerFromEnv(env) : deps.provider;
  if (!provider) return markFailed(env, { ...order, order_status: 'provisioning' }, 'provider_not_configured', now);

  await incrementVpnProvisioningAttempts(env.DB, order.id);

  const password = deps.password ?? (env.VPN_PROVISIONING_SECRET
    ? await derivePassword(env.VPN_PROVISIONING_SECRET, order.id)
    : null);
  if (!password) {
    return markFailed(env, { ...order, order_status: 'provisioning' }, 'provisioning_secret_not_configured', now);
  }

  const username = order.provider_username || provisioningUsername(order.id);
  const created = await provider.createAccount({ username, password });

  if (!created.ok) {
    if (
      created.error.kind === 'timeout' ||
      created.error.kind === 'network' ||
      created.error.kind === 'server' ||
      created.error.kind === 'unknown'
    ) {
      // The account may exist (gateway timeout / 5xx after creation). Never
      // release the claim or create a second account; a human/automated
      // reconciliation looks it up by the deterministic username.
      return markReconciliation(env, { ...order, order_status: 'provisioning' }, 'create_ambiguous', now);
    }
    return markFailed(
      env,
      { ...order, order_status: 'provisioning' },
      `provider_${created.error.kind}`,
      now,
    );
  }

  const account = created.data;
  const computedExpiry = expiryDateFor(now, order.interval_months);

  try {
    const saved = await saveVpnAccount(env.DB, {
      orderId: order.id,
      providerAccountId: String(account.id),
      username: account.username || username,
      expireAt: account.expire_at ?? null,
      now,
    });
    if (!saved) {
      const existing = await env.DB
        .prepare(`SELECT provider_account_id FROM vpn_accounts WHERE order_id = ?`)
        .bind(order.id)
        .first<{ provider_account_id: string }>();
      if (existing && existing.provider_account_id !== String(account.id)) {
        return markReconciliation(
          env,
          { ...order, order_status: 'provisioning' },
          'account_mapping_conflict',
          now,
          { providerAccountId: String(account.id) },
        );
      }
    }
  } catch {
    return markReconciliation(
      env,
      { ...order, order_status: 'provisioning' },
      'account_persist_failed',
      now,
      { providerAccountId: String(account.id) },
    );
  }

  const expiry = await provider.setExpiry(account.id, computedExpiry);
  if (!expiry.ok) {
    return markReconciliation(
      env,
      { ...order, order_status: 'provisioning' },
      'expiry_not_set',
      now,
      { providerAccountId: String(account.id) },
    );
  }

  const finalExpiry = expiry.data.expire_at?.slice(0, 10) || computedExpiry;
  const activated = await transitionVpnOrder(
    env.DB,
    order.id,
    'provisioning',
    'active',
    {
      provisioningStatus: 'succeeded',
      subscriptionStatus: 'active',
      providerAccountId: String(account.id),
      expireAt: finalExpiry,
      failureReason: null,
    },
    'provisioned',
    now,
  );
  if (!activated) {
    // A refund/cancel landed while the provider call was in flight. Never lose
    // the provider account id: persist it on the (now terminal) order row.
    const current = await getVpnOrder(env.DB, order.id);
    if (current && !current.provider_account_id) {
      await env.DB
        .prepare(
          `UPDATE vpn_orders SET provider_account_id = ?, expire_at = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND provider_account_id IS NULL`,
        )
        .bind(String(account.id), finalExpiry, now, order.id)
        .run();
    }
    return { status: 'reconciliation_required', reason: `activation_blocked_${current?.order_status ?? 'unknown'}` };
  }
  return { status: 'activated', accountId: account.id };
}

export type ReconcileOutcome =
  | { status: 'not_found' }
  | { status: 'not_reconcilable'; orderStatus: string }
  | { status: 'provider_not_configured' }
  | { status: 'activated'; accountId: number }
  | { status: 'still_missing'; reason: string }
  | { status: 'reconciliation_required'; reason: string };

/**
 * Read-only reconciliation: looks the deterministic username up at the provider.
 * It NEVER creates an account, so an ambiguous create cannot be duplicated.
 */
export async function reconcileVpnOrder(
  env: Env,
  orderId: string,
  deps: ProvisioningDeps = {},
): Promise<ReconcileOutcome> {
  const now = (deps.now ?? new Date()).toISOString();
  const order = await getVpnOrder(env.DB, orderId);
  if (!order) return { status: 'not_found' };
  const reconcilable: string[] = ['paid', 'provisioning', 'provisioning_failed', 'reconciliation_required'];
  if (!reconcilable.includes(order.order_status)) {
    return { status: 'not_reconcilable', orderStatus: order.order_status };
  }

  const provider = deps.provider === undefined ? providerFromEnv(env) : deps.provider;
  if (!provider) return { status: 'provider_not_configured' };

  const username = order.provider_username || provisioningUsername(order.id);
  const check = await provider.checkUsername(username);

  if (check.ok) {
    // Username is free => the provider never created the account. Release the
    // claim and move to a state an admin retry (`provision`) can start from.
    await releaseVpnProvisioningClaim(env.DB, order.id);
    if (order.order_status === 'provisioning' || order.order_status === 'reconciliation_required') {
      await transitionVpnOrder(
        env.DB,
        order.id,
        order.order_status,
        'provisioning_failed',
        { provisioningStatus: 'failed', failureReason: 'provider_account_not_found' },
        'reconcile_username_free',
        now,
      );
    }
    await recordVpnOrderEvent(env.DB, {
      orderId: order.id,
      from: order.order_status,
      to: order.order_status,
      reason: 'reconcile_username_free',
      now,
    });
    return { status: 'still_missing', reason: 'provider_account_not_found' };
  }

  if (check.error.kind !== 'validation') {
    return { status: 'reconciliation_required', reason: `provider_${check.error.kind}` };
  }

  // 422 means the username is taken: find its id via the documented list endpoint.
  let found: ProviderAccount | null = null;
  for (let page = 1; page <= 5 && !found; page++) {
    const listed = await provider.listAccounts(page, 100);
    if (!listed.ok) return { status: 'reconciliation_required', reason: `provider_${listed.error.kind}` };
    found = listed.data.find((account) => account.username === username) ?? null;
    if (listed.data.length < 100) break;
  }

  if (!found) return { status: 'reconciliation_required', reason: 'account_not_found_in_listing' };

  await saveVpnAccount(env.DB, {
    orderId: order.id,
    providerAccountId: String(found.id),
    username: found.username || username,
    expireAt: found.expire_at ?? null,
    now,
  });

  const existingAccount = await getVpnAccount(env.DB, order.id);
  if (!existingAccount || existingAccount.provider_account_id !== String(found.id)) {
    return { status: 'reconciliation_required', reason: 'account_mapping_conflict' };
  }

  const from = order.order_status;
  const activated = await transitionVpnOrder(
    env.DB,
    order.id,
    from,
    'active',
    {
      provisioningStatus: 'succeeded',
      subscriptionStatus: 'active',
      providerAccountId: String(found.id),
      expireAt: found.expire_at?.slice(0, 10) ?? order.expire_at,
      failureReason: null,
    },
    'reconciled',
    now,
  );

  if (!activated) {
    const current = await getVpnOrder(env.DB, order.id);
    if (current?.order_status === 'active') return { status: 'activated', accountId: found.id };
    return { status: 'reconciliation_required', reason: 'activation_race' };
  }

  return { status: 'activated', accountId: found.id };
}

/** Used by the webhook to mark an event processed after successful handling. */
export async function completePaymentEvent(env: Env, eventId: string, now: Date = new Date()): Promise<void> {
  await markVpnPaymentEventProcessed(env.DB, eventId, now.toISOString());
}
