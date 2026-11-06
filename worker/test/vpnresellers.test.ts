import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import {
  DEFAULT_BASE_URL,
  VpnResellersClient,
  classifyProviderStatus,
  loadVpnResellersConfig,
  sanitizeProviderMessage,
  type VpnResellersConfig,
} from '../vpnresellers';

const config: VpnResellersConfig = {
  baseUrl: DEFAULT_BASE_URL,
  apiToken: 'token-for-tests',
  projectId: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('configuration validation', () => {
  it('reports the missing secret instead of pretending to work', () => {
    const result = loadVpnResellersConfig({} as Env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('VPNRESELLERS_API_TOKEN');
  });

  it('defaults to the documented v4.1 base URL', () => {
    const result = loadVpnResellersConfig({ VPNRESELLERS_API_TOKEN: 'x' } as Env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.baseUrl).toBe(DEFAULT_BASE_URL);
      expect(result.config.projectId).toBeNull();
    }
  });

  it('strips trailing slashes and accepts a positive project id', () => {
    const result = loadVpnResellersConfig({
      VPNRESELLERS_API_TOKEN: 'x',
      VPNRESELLERS_API_URL: 'https://example.test/v4_1///',
      VPNRESELLERS_PROJECT_ID: '42',
    } as Env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.baseUrl).toBe('https://example.test/v4_1');
      expect(result.config.projectId).toBe(42);
    }
  });

  it('rejects a non-HTTPS base URL so the token is never sent in clear text', () => {
    const result = loadVpnResellersConfig({
      VPNRESELLERS_API_TOKEN: 'x',
      VPNRESELLERS_API_URL: 'http://api.example.test/v4_1',
    } as Env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalid).toContain('VPNRESELLERS_API_URL');
      expect(result.missing).toHaveLength(0);
    }
  });

  it('rejects an unparseable base URL', () => {
    const result = loadVpnResellersConfig({
      VPNRESELLERS_API_TOKEN: 'x',
      VPNRESELLERS_API_URL: 'not a url',
    } as Env);
    expect(result.ok).toBe(false);
  });

  it('ignores an invalid project id', () => {
    const result = loadVpnResellersConfig({
      VPNRESELLERS_API_TOKEN: 'x',
      VPNRESELLERS_PROJECT_ID: 'not-a-number',
    } as Env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.projectId).toBeNull();
  });
});

describe('provider error classification', () => {
  it('maps the documented statuses', () => {
    expect(classifyProviderStatus(400)).toBe('validation');
    expect(classifyProviderStatus(401)).toBe('unauthorized');
    expect(classifyProviderStatus(402)).toBe('insufficient_balance');
    expect(classifyProviderStatus(403)).toBe('forbidden');
    expect(classifyProviderStatus(404)).toBe('not_found');
    expect(classifyProviderStatus(422)).toBe('validation');
    expect(classifyProviderStatus(429)).toBe('rate_limited');
    expect(classifyProviderStatus(500)).toBe('server');
    expect(classifyProviderStatus(503)).toBe('server');
    expect(classifyProviderStatus(418)).toBe('unknown');
  });
});

describe('message sanitisation', () => {
  it('redacts a bare secret and bearer strings', () => {
    const message = sanitizeProviderMessage(
      { message: 'bad token-for-tests and Bearer abc.def' },
      ['token-for-tests'],
    );
    expect(message).not.toContain('token-for-tests');
    expect(message).not.toContain('abc.def');
    expect(message).toContain('[redacted]');
  });

  it('falls back safely when there is no message', () => {
    expect(sanitizeProviderMessage(undefined)).toBe('Provider request failed');
    expect(sanitizeProviderMessage({})).toBe('Provider request failed');
  });
});

describe('client requests', () => {
  it('creates an account with bearer auth and parses the data envelope', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return jsonResponse({
        data: { id: 9, username: 'alice', status: 'Active', expire_at: null },
        code: 201,
      }, 201);
    }) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.createAccount({ username: 'alice', password: 'secret-pass' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(201);
      expect(result.data.id).toBe(9);
      expect(result.data.status).toBe('Active');
    }
    expect(seen.url).toBe(`${DEFAULT_BASE_URL}/accounts`);
    expect(seen.init?.method).toBe('POST');
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer token-for-tests');
    expect(JSON.parse(String(seen.init?.body))).toEqual({ username: 'alice', password: 'secret-pass' });
  });

  it('encodes ids and query values safely', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return jsonResponse({ data: { id: 1, username: 'a', status: 'Active' } });
    }) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    await client.checkUsername('a b&c');
    await client.getAccount(77);

    expect(urls[0]).toBe(`${DEFAULT_BASE_URL}/accounts/check_username?username=a%20b%26c`);
    expect(urls[1]).toBe(`${DEFAULT_BASE_URL}/accounts/77`);
  });

  it('returns a typed validation error and the provider message', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'The given data was invalid.', code: 422 }, 422)) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.createAccount({ username: 'x', password: 'y' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error.kind).toBe('validation');
      expect(result.error.message).toBe('The given data was invalid.');
    }
  });

  it('surfaces insufficient balance as its own error kind', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'Insufficient Balance.', code: 402 }, 402)) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.createAccount({ username: 'x', password: 'y' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('insufficient_balance');
  });

  it('does not retry a failed create (avoids double provisioning)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ message: 'Server Error', code: 500 }, 500);
    }) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.createAccount({ username: 'x', password: 'y' });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('does not retry a failed mutation (setExpiry)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ message: 'Server Error', code: 500 }, 500);
    }) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.setExpiry(3, '2027-01-01');

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('retries a safe GET once on a transient server error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ message: 'Server Error', code: 500 }, 500)
        : jsonResponse({ data: { id: 5, username: 'x', status: 'Active' } });
    }) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.getAccount(5);

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('reports a timeout without leaking the token', async () => {
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl, timeoutMs: 10 });
    const result = await client.getAccount(1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout');
      expect(result.error.message).not.toContain('token-for-tests');
    }
  });

  it('times out a response body that never finishes', async () => {
    const stalled = {
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => {}),
    } as unknown as Response;

    const fetchImpl = (async () => stalled) as unknown as typeof fetch;
    const client = new VpnResellersClient(config, { fetchImpl, timeoutMs: 10 });
    const result = await client.getAccount(1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('timeout');
  });

  it('clears the expiry when asked to enable provider auto-renewal', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ data: { id: 3, username: 'x', status: 'Active', expire_at: null } });
    }) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    await client.setExpiry(3, null);

    expect(bodies[0]).toEqual({ expire_at: null });
  });

  it('never returns the bare token even if the provider echoes it', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'invalid token-for-tests', code: 401 }, 401)) as unknown as typeof fetch;

    const client = new VpnResellersClient(config, { fetchImpl });
    const result = await client.getAccount(1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unauthorized');
      expect(result.error.message).not.toContain('token-for-tests');
    }
    expect(JSON.stringify(result)).not.toContain('token-for-tests');
  });
});
