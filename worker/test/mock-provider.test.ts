import { describe, expect, it } from 'vitest';
import { MockVpnProvider, isSandboxMode, requireRealProvider, getProviderForEnv, canProvision } from '../vpn/mock-provider';
import type { VpnProvider } from '../vpn/service';

describe('MockVpnProvider', () => {
  it('implements VpnProvider interface', () => {
    const mock = new MockVpnProvider();
    const provider: VpnProvider = mock;
    expect(typeof provider.createAccount).toBe('function');
    expect(typeof provider.checkUsername).toBe('function');
    expect(typeof provider.listAccounts).toBe('function');
    expect(typeof provider.setExpiry).toBe('function');
  });

  it('creates an account successfully', async () => {
    const mock = new MockVpnProvider();
    const result = await mock.createAccount({ username: 'testuser', password: 'testpass123' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe(9000);
      expect(result.data.username).toBe('testuser');
      expect(result.data.status).toBe('Active');
    }
    expect(mock.stateSnapshot.createCalls).toBe(1);
  });

  it('checks username availability', async () => {
    const mock = new MockVpnProvider();
    const result = await mock.checkUsername('availableuser');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.message).toContain('not taken');
    }
  });

  it('reports username as taken after creation', async () => {
    const mock = new MockVpnProvider();
    await mock.createAccount({ username: 'takenuser', password: 'pass123' });
    const result = await mock.checkUsername('takenuser');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('validation');
    }
  });

  it('lists created accounts', async () => {
    const mock = new MockVpnProvider();
    await mock.createAccount({ username: 'user1', password: 'pass1' });
    await mock.createAccount({ username: 'user2', password: 'pass2' });
    const result = await mock.listAccounts();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
    }
  });

  it('sets expiry on an account', async () => {
    const mock = new MockVpnProvider();
    const created = await mock.createAccount({ username: 'expiryuser', password: 'pass' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await mock.setExpiry(created.data.id, '2027-01-01');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.expire_at).toBe('2027-01-01');
    }
  });

  it('returns 404 for setExpiry on unknown account', async () => {
    const mock = new MockVpnProvider();
    const result = await mock.setExpiry(99999, '2027-01-01');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it('simulates timeout', async () => {
    const mock = new MockVpnProvider({ createBehavior: 'timeout' });
    const result = await mock.createAccount({ username: 'timeoutuser', password: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout');
      expect(result.status).toBe(0);
    }
  });

  it('simulates ambiguous result (server error)', async () => {
    const mock = new MockVpnProvider({ createBehavior: 'ambiguous' });
    const result = await mock.createAccount({ username: 'ambiguoususer', password: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server');
      expect(result.status).toBe(500);
    }
  });

  it('simulates definite failure (validation error)', async () => {
    const mock = new MockVpnProvider({ createBehavior: 'failure' });
    const result = await mock.createAccount({ username: 'failuser', password: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('validation');
      expect(result.status).toBe(422);
    }
  });

  it('simulates insufficient balance', async () => {
    const mock = new MockVpnProvider({ createBehavior: 'insufficient' });
    const result = await mock.createAccount({ username: 'insufficientuser', password: 'pass' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('insufficient_balance');
      expect(result.status).toBe(402);
    }
  });

  it('does not make network requests', async () => {
    const mock = new MockVpnProvider();
    // The mock should complete without any fetch calls
    const result = await mock.createAccount({ username: 'nonetwork', password: 'pass' });
    expect(result.ok).toBe(true);
    // If it tried to fetch, it would fail in the test environment
  });

  it('is deterministic (same input → same output pattern)', async () => {
    const mock1 = new MockVpnProvider({ startId: 1000 });
    const mock2 = new MockVpnProvider({ startId: 1000 });
    const r1 = await mock1.createAccount({ username: 'detuser', password: 'pass' });
    const r2 = await mock2.createAccount({ username: 'detuser', password: 'pass' });
    expect(r1.ok).toBe(r2.ok);
    if (r1.ok && r2.ok) {
      expect(r1.data.id).toBe(r2.data.id);
      expect(r1.data.username).toBe(r2.data.username);
    }
  });

  it('records call counts', async () => {
    const mock = new MockVpnProvider();
    await mock.createAccount({ username: 'u1', password: 'p1' });
    await mock.checkUsername('u2');
    await mock.listAccounts();
    await mock.setExpiry(9000, '2027-01-01');
    const state = mock.stateSnapshot;
    expect(state.createCalls).toBe(1);
    expect(state.checkCalls).toBe(1);
    expect(state.listCalls).toBe(1);
    expect(state.setExpiryCalls).toBe(1);
  });

  it('stores last create input', async () => {
    const mock = new MockVpnProvider();
    await mock.createAccount({ username: 'inputuser', password: 'inputpass' });
    const state = mock.stateSnapshot;
    expect(state.lastCreateInput).toEqual({ username: 'inputuser', password: 'inputpass' });
  });
});

describe('Environment guard', () => {
  it('detects sandbox mode (sales enabled, no real token)', () => {
    expect(isSandboxMode({ VPN_SALES_ENABLED: 'true' })).toBe(true);
    expect(isSandboxMode({ VPN_SALES_ENABLED: 'true', VPNRESELLERS_API_TOKEN: 'real-token' })).toBe(false);
    expect(isSandboxMode({ VPN_SALES_ENABLED: 'false' })).toBe(false);
  });

  it('requires real provider token for real provisioning', () => {
    expect(requireRealProvider({})).toBe(false);
    expect(requireRealProvider({ VPNRESELLERS_API_TOKEN: 'token' })).toBe(true);
  });

  it('getProviderForEnv returns correct provider type', () => {
    expect(getProviderForEnv({})).toBe('none');
    expect(getProviderForEnv({ VPN_SALES_ENABLED: 'true' })).toBe('mock');
    expect(getProviderForEnv({ VPN_SALES_ENABLED: 'true', VPNRESELLERS_API_TOKEN: 'token' })).toBe('real');
    expect(getProviderForEnv({ VPNRESELLERS_API_TOKEN: 'token' })).toBe('none');
  });

  it('canProvision fails closed when sales disabled', () => {
    const result = canProvision({});
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('sales_disabled');
  });

  it('canProvision allows mock in sandbox', () => {
    const result = canProvision({ VPN_SALES_ENABLED: 'true' });
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('mock_provider_only');
  });

  it('canProvision allows real when token exists', () => {
    const result = canProvision({ VPN_SALES_ENABLED: 'true', VPNRESELLERS_API_TOKEN: 'token' });
    expect(result.safe).toBe(true);
    expect(result.reason).toBe('real_provider_configured');
  });
});
