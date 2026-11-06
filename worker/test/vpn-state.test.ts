import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canAcceptPayment,
  canAcceptRefund,
  canTransition,
  isTerminal,
  type VpnOrderStatus,
} from '../vpn/state';

describe('VPN order state machine', () => {
  it('allows the documented happy path', () => {
    const path: VpnOrderStatus[] = ['pending_payment', 'paid', 'provisioning', 'active', 'expired'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows failure and reconciliation branches without losing the payment', () => {
    expect(canTransition('provisioning', 'provisioning_failed')).toBe(true);
    expect(canTransition('provisioning', 'reconciliation_required')).toBe(true);
    expect(canTransition('reconciliation_required', 'active')).toBe(true);
    expect(canTransition('provisioning_failed', 'active')).toBe(true);
    expect(canTransition('provisioning_failed', 'provisioning')).toBe(true);
    expect(canTransition('paid', 'active')).toBe(true); // recovery when the account exists
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('pending_payment', 'active')).toBe(false);
    expect(canTransition('pending_payment', 'provisioning')).toBe(false);
    expect(canTransition('active', 'paid')).toBe(false);
    expect(canTransition('refunded', 'active')).toBe(false);
    expect(canTransition('cancelled', 'paid')).toBe(false);
    expect(() => assertTransition('refunded', 'active')).toThrow(/Invalid VPN order transition/);
  });

  it('treats refunded and cancelled as terminal', () => {
    expect(isTerminal('refunded')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('active')).toBe(false);
  });

  it('accepts payment only for an unpaid pending order', () => {
    expect(canAcceptPayment({ orderStatus: 'pending_payment', paymentStatus: 'unpaid' })).toBe(true);
    expect(canAcceptPayment({ orderStatus: 'pending_payment', paymentStatus: 'paid' })).toBe(false);
    expect(canAcceptPayment({ orderStatus: 'refunded', paymentStatus: 'refunded' })).toBe(false);
  });

  it('accepts a refund only while the order is still paid or provisioned', () => {
    expect(canAcceptRefund({ orderStatus: 'paid' })).toBe(true);
    expect(canAcceptRefund({ orderStatus: 'active' })).toBe(true);
    expect(canAcceptRefund({ orderStatus: 'provisioning' })).toBe(true);
    expect(canAcceptRefund({ orderStatus: 'provisioning_failed' })).toBe(true);
    expect(canAcceptRefund({ orderStatus: 'reconciliation_required' })).toBe(true);
    expect(canAcceptRefund({ orderStatus: 'pending_payment' })).toBe(false);
    expect(canAcceptRefund({ orderStatus: 'refunded' })).toBe(false);
  });
});
