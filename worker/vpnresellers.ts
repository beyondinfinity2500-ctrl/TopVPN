/**
 * VPNResellers API v4.1 — server-side client.
 *
 * Contract verified against https://api.vpnresellers.com/docs/v4_1/ on 2026-10-27:
 *   - Base URL: https://api.vpnresellers.com/v4_1
 *   - Auth: `Authorization: Bearer {token}` for account management endpoints.
 *     (`/un/accounts/show` uses the end user's Basic auth; not used here.)
 *   - JSON in/out; documented errors: 400/401/402/403/404/405/422.
 *   - Account statuses: "Active" | "Disabled".
 *   - `expire_at`: "YYYY-MM-DD" or null (null clears expiry => auto-renewal).
 *
 * SAFETY:
 *   - No network I/O at import time.
 *   - The token is only placed in request headers. Provider error text is
 *     redacted and truncated before it is returned, so a provider echo can
 *     never leak the token or the submitted VPN password.
 *   - Mutations are not retried automatically (a duplicate create charges the
 *     reseller balance twice). Only safe GETs retry.
 *   - Timeout covers both the response headers and the body read.
 *   - Tests inject a mocked fetch; no live provider call is made.
 *
 * UNVERIFIED (do not assume): rate limits are absent from the public docs; the
 * by-id disable example shows a different path than its heading. Confirm both
 * with VPNResellers before enabling live automation.
 */
import type { Env } from './env';

export const DEFAULT_BASE_URL = 'https://api.vpnresellers.com/v4_1';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface VpnResellersConfig {
  baseUrl: string;
  apiToken: string;
  /** Optional project id used when creating a linked customer. */
  projectId: number | null;
}

export type VpnResellersConfigResult =
  | { ok: true; config: VpnResellersConfig }
  | { ok: false; missing: string[]; invalid?: string[] };

/** Read and validate server-side configuration. Never throws. */
export function loadVpnResellersConfig(env: Env): VpnResellersConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!env.VPNRESELLERS_API_TOKEN) missing.push('VPNRESELLERS_API_TOKEN');

  const rawBase = (env.VPNRESELLERS_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const baseUrl = rawBase;
  try {
    const parsed = new URL(rawBase);
    if (parsed.protocol !== 'https:') invalid.push('VPNRESELLERS_API_URL');
  } catch {
    invalid.push('VPNRESELLERS_API_URL');
  }

  if (missing.length > 0 || invalid.length > 0) {
    return invalid.length > 0 ? { ok: false, missing, invalid } : { ok: false, missing };
  }

  const parsedProject = env.VPNRESELLERS_PROJECT_ID ? Number(env.VPNRESELLERS_PROJECT_ID) : NaN;

  return {
    ok: true,
    config: {
      baseUrl,
      apiToken: env.VPNRESELLERS_API_TOKEN as string,
      projectId: Number.isInteger(parsedProject) && parsedProject > 0 ? parsedProject : null,
    },
  };
}

export type ProviderErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'insufficient_balance'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unknown';

/** Map a documented HTTP status to an actionable error category. */
export function classifyProviderStatus(status: number): ProviderErrorKind {
  switch (status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
      return 'unauthorized';
    case 402:
      return 'insufficient_balance';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'server' : 'unknown';
  }
}

export interface ProviderAccount {
  id: number;
  username: string;
  status: string;
  wg_ip?: string | null;
  wg_private_key?: string | null;
  wg_public_key?: string | null;
  expire_at?: string | null;
  created?: string;
  updated?: string;
}

/** `GET /configuration/*` returns `{ content, name }` (Accept: application/json). */
export interface ProviderConfigPayload {
  content?: string;
  name?: string;
}

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
}

export type ProviderResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ProviderError };

export interface CreateAccountInput {
  username: string;
  password: string;
  customer?: {
    customer_id?: number;
    first_name?: string;
    last_name?: string;
    email?: string;
    project_id?: number;
  };
}

export interface ClientOptions {
  /** Injectable for tests. Defaults to the runtime fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

/** Truncate provider text and remove anything that looks like a credential. */
export function sanitizeProviderMessage(body: unknown, secrets: string[] = []): string {
  let text = 'Provider request failed';
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') text = message;
  }
  text = text.slice(0, 200);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(BEARER_RE, 'Bearer [redacted]');
}

/** Reject the promise when `signal` aborts (covers a stalled body read). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class VpnResellersClient {
  private readonly config: VpnResellersConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: VpnResellersConfig, options: ClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET is safe to retry once; mutations are not (see file header). */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { retryable?: boolean } = {},
  ): Promise<ProviderResult<T>> {
    const attempts = opts.retryable ? 2 : 1;
    let last: ProviderResult<T> | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      last = await this.attempt<T>(method, path, body);
      if (last.ok) return last;
      const transient =
        last.error.kind === 'timeout' || last.error.kind === 'network' || last.error.kind === 'server';
      if (!transient || attempt === attempts - 1) return last;
    }

    return last as ProviderResult<T>;
  }

  private async attempt<T>(method: string, path: string, body?: unknown): Promise<ProviderResult<T>> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiToken}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await abortable(
        this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      );

      // Keep the timeout armed while reading the body (a server may send
      // headers and then stall), then disarm once the body is complete.
      const raw = await abortable(response.text(), controller.signal);

      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }

      if (response.ok) {
        const data =
          parsed && typeof parsed === 'object' && 'data' in parsed
            ? (parsed as { data: unknown }).data
            : parsed;
        return { ok: true, status: response.status, data: data as T };
      }

      return {
        ok: false,
        status: response.status,
        error: {
          kind: classifyProviderStatus(response.status),
          message: sanitizeProviderMessage(parsed, [this.config.apiToken]),
        },
      };
    } catch {
      return {
        ok: false,
        status: 0,
        error: timedOut
          ? { kind: 'timeout', message: 'Provider request timed out' }
          : { kind: 'network', message: 'Provider request failed' },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  checkUsername(username: string): Promise<ProviderResult<{ message?: string; code?: number }>> {
    return this.request('GET', `/accounts/check_username?username=${encodeURIComponent(username)}`, undefined, {
      retryable: true,
    });
  }

  listAccounts(
    page = 1,
    perPage = 15,
    status?: 'Active' | 'Disabled',
  ): Promise<ProviderResult<ProviderAccount[]>> {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (status) params.set('status', status);
    return this.request('GET', `/accounts?${params.toString()}`, undefined, { retryable: true });
  }

  getAccount(id: number): Promise<ProviderResult<ProviderAccount>> {
    return this.request('GET', `/accounts/${encodeURIComponent(String(id))}`, undefined, { retryable: true });
  }

  /** Creates one provider account. Never auto-retried (would double-charge balance). */
  createAccount(input: CreateAccountInput): Promise<ProviderResult<ProviderAccount>> {
    const body: Record<string, unknown> = { username: input.username, password: input.password };
    if (input.customer) body.customer = input.customer;
    return this.request('POST', '/accounts', body);
  }

  /** `expireAt` null clears the expiry and enables the provider's auto-renewal. */
  setExpiry(id: number, expireAt: string | null): Promise<ProviderResult<ProviderAccount>> {
    return this.request('PUT', `/accounts/${encodeURIComponent(String(id))}/expire`, { expire_at: expireAt });
  }

  enableAccount(id: number): Promise<ProviderResult<ProviderAccount>> {
    return this.request('PUT', `/accounts/${encodeURIComponent(String(id))}/enable`);
  }

  disableAccount(id: number): Promise<ProviderResult<ProviderAccount>> {
    return this.request('PUT', `/accounts/${encodeURIComponent(String(id))}/disable`);
  }

  /** WireGuard config for an account on a specific server. */
  getWireguardConfig(serverId: number, accountId: number): Promise<ProviderResult<ProviderConfigPayload>> {
    return this.request(
      'GET',
      `/configuration/wireguard?server_id=${encodeURIComponent(String(serverId))}&account_id=${encodeURIComponent(String(accountId))}`,
      undefined,
      { retryable: true },
    );
  }

  /** OpenVPN config for a server/port (auth is the account username + password). */
  getOpenVpnConfig(serverId: number, portId: number): Promise<ProviderResult<ProviderConfigPayload>> {
    return this.request(
      'GET',
      `/configuration/openvpn?server_id=${encodeURIComponent(String(serverId))}&port_id=${encodeURIComponent(String(portId))}`,
      undefined,
      { retryable: true },
    );
  }
}
