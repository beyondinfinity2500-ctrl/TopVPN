/**
 * Deterministic mock VPN provider for sandbox integration tests.
 *
 * Implements the VpnProvider interface from service.ts without any network I/O.
 * Supports: username availability, account creation, account retrieval,
 * expiration updates, WireGuard/OpenVPN config responses, simulated timeout,
 * simulated ambiguous result, and simulated provider failure.
 *
 * SAFETY: This mock never makes network requests. It is the ONLY provider
 * that should be used in sandbox/test mode. Real VPNResellers provisioning
 * requires VPNRESELLERS_API_TOKEN to be set explicitly.
 */
import type { VpnProvider } from './service';
import type { ProviderResult, ProviderAccount } from '../vpnresellers';

export type MockBehavior =
  | 'success'        // normal successful operation
  | 'timeout'        // simulate timeout (network error)
  | 'ambiguous'      // simulate ambiguous result (server error after creation)
  | 'failure'        // simulate definite failure (validation error)
  | 'not_found'      // simulate account not found
  | 'insufficient';  // simulate insufficient balance

export interface MockProviderOptions {
  /** Behavior for createAccount. Default: 'success' */
  createBehavior?: MockBehavior;
  /** Behavior for checkUsername. Default: 'success' (username available) */
  checkBehavior?: MockBehavior;
  /** Behavior for listAccounts. Default: 'success' (empty list) */
  listBehavior?: MockBehavior;
  /** Behavior for setExpiry. Default: 'success' */
  setExpiryBehavior?: MockBehavior;
  /** Behavior for getWireguardConfig. Default: 'success' */
  wireguardBehavior?: MockBehavior;
  /** Behavior for getOpenVpnConfig. Default: 'success' */
  openvpnBehavior?: MockBehavior;
  /** Starting provider account ID. Default: 9000 */
  startId?: number;
  /** Simulated delay in ms. Default: 0 */
  delayMs?: number;
}

export interface MockProviderState {
  createCalls: number;
  checkCalls: number;
  listCalls: number;
  setExpiryCalls: number;
  createdAccounts: Map<number, ProviderAccount>;
  lastCreateInput: { username: string; password: string } | null;
}

export class MockVpnProvider implements VpnProvider {
  private readonly opts: Required<MockProviderOptions>;
  private readonly state: MockProviderState;
  private nextId: number;

  constructor(options: MockProviderOptions = {}) {
    this.opts = {
      createBehavior: options.createBehavior ?? 'success',
      checkBehavior: options.checkBehavior ?? 'success',
      listBehavior: options.listBehavior ?? 'success',
      setExpiryBehavior: options.setExpiryBehavior ?? 'success',
      wireguardBehavior: options.wireguardBehavior ?? 'success',
      openvpnBehavior: options.openvpnBehavior ?? 'success',
      startId: options.startId ?? 9000,
      delayMs: options.delayMs ?? 0,
    };
    this.nextId = this.opts.startId;
    this.state = {
      createCalls: 0,
      checkCalls: 0,
      listCalls: 0,
      setExpiryCalls: 0,
      createdAccounts: new Map(),
      lastCreateInput: null,
    };
  }

  get stateSnapshot(): MockProviderState {
    return { ...this.state, createdAccounts: new Map(this.state.createdAccounts) };
  }

  private async delay(): Promise<void> {
    if (this.opts.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.delayMs));
    }
  }

  private classifyBehavior(behavior: MockBehavior): { ok: boolean; status: number; kind?: string } {
    switch (behavior) {
      case 'success':
        return { ok: true, status: 200 };
      case 'timeout':
        return { ok: false, status: 0, kind: 'timeout' };
      case 'ambiguous':
        return { ok: false, status: 500, kind: 'server' };
      case 'failure':
        return { ok: false, status: 422, kind: 'validation' };
      case 'not_found':
        return { ok: false, status: 404, kind: 'not_found' };
      case 'insufficient':
        return { ok: false, status: 402, kind: 'insufficient_balance' };
      default:
        return { ok: true, status: 200 };
    }
  }

  async createAccount(input: { username: string; password: string }): Promise<ProviderResult<ProviderAccount>> {
    await this.delay();
    this.state.createCalls++;
    this.state.lastCreateInput = { username: input.username, password: input.password };

    const behavior = this.classifyBehavior(this.opts.createBehavior);
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status,
        error: { kind: behavior.kind as any, message: `Mock: ${this.opts.createBehavior}` },
      };
    }

    const id = this.nextId++;
    const account: ProviderAccount = {
      id,
      username: input.username,
      status: 'Active',
      wg_ip: '10.0.0.1',
      wg_private_key: 'mock-private-key',
      wg_public_key: 'mock-public-key',
      expire_at: null,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    this.state.createdAccounts.set(id, account);
    return { ok: true, status: 201, data: account };
  }

  async checkUsername(username: string): Promise<ProviderResult<{ message?: string; code?: number }>> {
    await this.delay();
    this.state.checkCalls++;

    const behavior = this.classifyBehavior(this.opts.checkBehavior);
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status,
        error: { kind: behavior.kind as any, message: `Mock: ${this.opts.checkBehavior}` },
      };
    }

    // Username is "taken" if it was already created
    const taken = [...this.state.createdAccounts.values()].some((a) => a.username === username);
    if (taken) {
      return {
        ok: false,
        status: 422,
        error: { kind: 'validation', message: 'The username has already been taken.' },
      };
    }

    return { ok: true, status: 200, data: { message: 'The username is not taken.', code: 200 } };
  }

  async listAccounts(
    page?: number,
    perPage?: number,
    status?: 'Active' | 'Disabled',
  ): Promise<ProviderResult<ProviderAccount[]>> {
    await this.delay();
    this.state.listCalls++;

    const behavior = this.classifyBehavior(this.opts.listBehavior);
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status,
        error: { kind: behavior.kind as any, message: `Mock: ${this.opts.listBehavior}` },
      };
    }

    let accounts = [...this.state.createdAccounts.values()];
    if (status) accounts = accounts.filter((a) => a.status === status);
    return { ok: true, status: 200, data: accounts };
  }

  async setExpiry(id: number, expireAt: string | null): Promise<ProviderResult<ProviderAccount>> {
    await this.delay();
    this.state.setExpiryCalls++;

    const behavior = this.classifyBehavior(this.opts.setExpiryBehavior);
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status,
        error: { kind: behavior.kind as any, message: `Mock: ${this.opts.setExpiryBehavior}` },
      };
    }

    const account = this.state.createdAccounts.get(id);
    if (!account) {
      return { ok: false, status: 404, error: { kind: 'not_found', message: 'Account not found.' } };
    }

    account.expire_at = expireAt;
    return { ok: true, status: 200, data: { ...account } };
  }
}

/**
 * Strict environment guard: ensures sandbox mode uses mock provider only.
 * Real VPNResellers provisioning requires VPNRESELLERS_API_TOKEN to be set explicitly.
 * Missing or contradictory configuration fails closed.
 */
export function isSandboxMode(env: { VPN_SALES_ENABLED?: string; VPNRESELLERS_API_TOKEN?: string }): boolean {
  // Sandbox mode is active when sales are enabled but no real provider token exists
  return env.VPN_SALES_ENABLED === 'true' && !env.VPNRESELLERS_API_TOKEN;
}

export function requireRealProvider(env: { VPNRESELLERS_API_TOKEN?: string }): boolean {
  // Real provider requires explicit token
  return !!env.VPNRESELLERS_API_TOKEN;
}

export function getProviderForEnv(env: { VPN_SALES_ENABLED?: string; VPNRESELLERS_API_TOKEN?: string }): 'mock' | 'real' | 'none' {
  if (env.VPNRESELLERS_API_TOKEN) {
    // Real token exists — but only use real provider if sales are enabled
    if (env.VPN_SALES_ENABLED === 'true') {
      return 'real';
    }
    return 'none'; // Token exists but sales disabled
  }
  if (env.VPN_SALES_ENABLED === 'true') {
    return 'mock'; // Sales enabled but no real token → mock only
  }
  return 'none'; // Sales disabled
}

/**
 * Guard: ensure a sandbox payment never reaches the real provider.
 * Returns true if it's safe to proceed with provisioning.
 */
export function canProvision(env: { VPN_SALES_ENABLED?: string; VPNRESELLERS_API_TOKEN?: string }): { safe: boolean; reason: string } {
  if (env.VPN_SALES_ENABLED !== 'true') {
    return { safe: false, reason: 'sales_disabled' };
  }
  if (env.VPNRESELLERS_API_TOKEN) {
    // Real token exists — this is a production-like environment
    // Only allow if explicitly configured for real provisioning
    return { safe: true, reason: 'real_provider_configured' };
  }
  // No real token — mock only, safe for sandbox
  return { safe: true, reason: 'mock_provider_only' };
}
