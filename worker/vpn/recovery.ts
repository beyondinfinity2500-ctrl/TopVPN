/**
 * Bounded, manual provisioning recovery.
 *
 * There is no scheduled sweep (the deployment has no cron trigger and this
 * phase must not add one). An administrator can list recoverable orders and run
 * a bounded recovery. Ambiguous creates are only EVER reconciled by lookup, and
 * a definitive failure is retried at most MAX_PROVISIONING_ATTEMPTS times.
 */
import type { Env } from '../env';
import { countVpnProvisioningAttempts, getVpnOrder } from './repo';
import {
  provisionVpnOrder,
  reconcileVpnOrder,
  type ProvisionOutcome,
  type ProvisioningDeps,
  type ReconcileOutcome,
} from './service';

export const MAX_PROVISIONING_ATTEMPTS = 5;
export const STALE_PROVISIONING_MINUTES = 15;

export type RecoveryAction = 'none' | 'provision' | 'reconcile' | 'wait' | 'manual_review';

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
}

export interface RecoveryOrder {
  order_status: string;
  failure_reason: string | null;
  updated_at: string;
}

/** Pure classification; the caller supplies the persisted attempt count. */
export function classifyRecovery(
  order: RecoveryOrder,
  attempts: number,
  now: Date = new Date(),
): RecoveryDecision {
  const recoverable = ['paid', 'provisioning', 'provisioning_failed', 'reconciliation_required'];
  if (!recoverable.includes(order.order_status)) {
    return { action: 'none', reason: 'not_recoverable' };
  }
  if (attempts >= MAX_PROVISIONING_ATTEMPTS) {
    return { action: 'manual_review', reason: 'attempt_limit' };
  }
  if (order.order_status === 'reconciliation_required') {
    return { action: 'reconcile', reason: 'ambiguous_previous_attempt' };
  }
  if (order.order_status === 'provisioning') {
    const updated = new Date(order.updated_at).getTime();
    if (!Number.isFinite(updated)) return { action: 'reconcile', reason: 'stale_provisioning' };
    const ageMinutes = (now.getTime() - updated) / 60_000;
    return ageMinutes >= STALE_PROVISIONING_MINUTES
      ? { action: 'reconcile', reason: 'stale_provisioning' }
      : { action: 'wait', reason: 'in_progress' };
  }
  if (order.order_status === 'paid') {
    return { action: 'provision', reason: 'paid' };
  }
  // provisioning_failed
  if ((order.failure_reason ?? '').startsWith('provider_validation')) {
    return { action: 'reconcile', reason: 'possible_existing_account' };
  }
  return { action: 'provision', reason: 'retry_after_fix' };
}

export type RecoveryResult =
  | { status: 'not_found' }
  | { status: 'not_recoverable'; decision: RecoveryDecision }
  | { status: 'waiting'; decision: RecoveryDecision }
  | { status: 'manual_review'; decision: RecoveryDecision }
  | { status: 'reconciled'; decision: RecoveryDecision; result: ReconcileOutcome }
  | { status: 'provisioned'; decision: RecoveryDecision; result: ProvisionOutcome };

export async function recoverVpnOrder(
  env: Env,
  orderId: string,
  deps: ProvisioningDeps = {},
): Promise<RecoveryResult> {
  const order = await getVpnOrder(env.DB, orderId);
  if (!order) return { status: 'not_found' };

  const attempts = await countVpnProvisioningAttempts(env.DB, orderId);
  const decision = classifyRecovery(order, attempts, deps.now ?? new Date());

  if (decision.action === 'none') return { status: 'not_recoverable', decision };
  if (decision.action === 'wait') return { status: 'waiting', decision };
  if (decision.action === 'manual_review') return { status: 'manual_review', decision };

  if (decision.action === 'reconcile') {
    return { status: 'reconciled', decision, result: await reconcileVpnOrder(env, orderId, deps) };
  }
  return { status: 'provisioned', decision, result: await provisionVpnOrder(env, orderId, deps) };
}
