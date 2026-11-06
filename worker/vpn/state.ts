/**
 * VPN order lifecycle — explicit, testable state machine.
 *
 * Four independent dimensions are tracked on the order row:
 *   order_status         lifecycle position (this machine)
 *   payment_status       unpaid | paid | refunded
 *   provisioning_status  none | claimed | provisioning | succeeded | failed | reconciliation
 *   subscription_status  none | active | expired | cancelled
 *
 * Rules encoded here (not in routes):
 *   - a redirect or a client-supplied id never marks an order paid;
 *   - a refunded/cancelled order never becomes active again;
 *   - refunding does NOT automatically suspend the provider account.
 */

export const VPN_ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'provisioning',
  'active',
  'provisioning_failed',
  'reconciliation_required',
  'expired',
  'cancelled',
  'refunded',
] as const;
export type VpnOrderStatus = (typeof VPN_ORDER_STATUSES)[number];

export const VPN_PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'] as const;
export type VpnPaymentStatus = (typeof VPN_PAYMENT_STATUSES)[number];

export const VPN_PROVISIONING_STATUSES = [
  'none',
  'claimed',
  'provisioning',
  'succeeded',
  'failed',
  'reconciliation',
] as const;
export type VpnProvisioningStatus = (typeof VPN_PROVISIONING_STATUSES)[number];

export const VPN_SUBSCRIPTION_STATUSES = ['none', 'active', 'expired', 'cancelled'] as const;
export type VpnSubscriptionStatus = (typeof VPN_SUBSCRIPTION_STATUSES)[number];

/** Allowed order-status transitions. Anything else is a bug or a replayed event. */
const TRANSITIONS: Record<VpnOrderStatus, readonly VpnOrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['provisioning', 'active', 'refunded', 'cancelled'],
  provisioning: ['active', 'provisioning_failed', 'reconciliation_required'],
  active: ['expired', 'refunded'],
  provisioning_failed: ['provisioning', 'reconciliation_required', 'active', 'refunded', 'cancelled'],
  reconciliation_required: ['active', 'provisioning_failed', 'refunded', 'cancelled'],
  expired: ['active', 'cancelled'],
  cancelled: [],
  refunded: [],
};

export function isVpnOrderStatus(value: unknown): value is VpnOrderStatus {
  return typeof value === 'string' && (VPN_ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: VpnOrderStatus, to: VpnOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: VpnOrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  readonly code = 'invalid_transition';
  constructor(
    readonly from: VpnOrderStatus,
    readonly to: VpnOrderStatus,
  ) {
    super(`Invalid VPN order transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: VpnOrderStatus, to: VpnOrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** A paid event is only meaningful for orders that can still become paid. */
export function canAcceptPayment(order: { orderStatus: VpnOrderStatus; paymentStatus: VpnPaymentStatus }): boolean {
  return order.paymentStatus === 'unpaid' && order.orderStatus === 'pending_payment';
}

/** Refunds are accepted from paid/active/provisioning states, never from a refund. */
export function canAcceptRefund(order: { orderStatus: VpnOrderStatus }): boolean {
  return (
    order.orderStatus === 'paid' ||
    order.orderStatus === 'active' ||
    order.orderStatus === 'provisioning' ||
    order.orderStatus === 'provisioning_failed' ||
    order.orderStatus === 'reconciliation_required'
  );
}
