import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, testEnv } from './helpers';
import { credentialsPage } from '../routes/account';
import { buildConnectionInfo, type CredentialProvider } from '../vpn/credentials';
import { randomToken, sha256Hex } from '../customer/auth';
import { createCustomerSession, findOrCreateCustomer, linkOrdersToCustomer } from '../customer/repo';
import { getVpnOrder, insertVpnOrder } from '../vpn/repo';

beforeAll(async () => {
  await applyMigrations();
});

function envWg(extra: Partial<Env> = {}): Env {
  return {
    DB: testEnv.DB,
    VPN_CREDENTIAL_DELIVERY_ENABLED: 'true',
    VPNRESELLERS_API_TOKEN: 'provider-token-for-tests',
    VPN_PROVISIONING_SECRET: 'provision-secret-for-tests',
    VPN_WIREGUARD_SERVER_ID: '7',
    ...extra,
  } as unknown as Env;
}

function fakeProvider(mode: 'ok' | 'error' = 'ok') {
  const calls = { wg: 0, ovpn: 0 };
  const provider: CredentialProvider = {
    async getWireguardConfig() {
      calls.wg++;
      if (mode === 'error') {
        return { ok: false, status: 502, error: { kind: 'server', message: 'bad gateway' } };
      }
      return { ok: true, status: 200, data: { content: '[Interface]\nPrivateKey=abc123', name: 'wg.conf' } };
    },
    async getOpenVpnConfig() {
      calls.ovpn++;
      return { ok: true, status: 200, data: { content: 'client\nremote vpn.example 1194', name: 'ovpn.ovpn' } };
    },
  };
  return { provider, calls };
}

async function seed(order: 'active' | 'pending' = 'active') {
  const email = `cred-${crypto.randomUUID()}@example.com`;
  const now = new Date().toISOString();
  const customer = await findOrCreateCustomer(testEnv.DB, email, now);
  const orderId = `ORD-VPN-${crypto.randomUUID()}`;
  await insertVpnOrder(testEnv.DB, {
    id: orderId,
    customerEmail: email,
    customerName: null,
    planId: 'monthly',
    intervalMonths: 1,
    amountCents: 900,
    currency: 'USD',
    providerUsername: 'topvpn-test',
    now,
  });
  if (order === 'active') {
    const providerAccountId = String(9000 + Math.floor(Math.random() * 100000));
    await testEnv.DB.prepare(
      `UPDATE vpn_orders SET order_status='active', payment_status='paid', provisioning_status='succeeded',
        provider_account_id=?, provider_username='topvpn-test', expire_at='2027-01-01' WHERE id=?`,
    )
      .bind(providerAccountId, orderId)
      .run();
  }
  await linkOrdersToCustomer(testEnv.DB, customer.id, email, now);

  const raw = randomToken();
  await createCustomerSession(testEnv.DB, {
    tokenHash: await sha256Hex(raw),
    customerId: customer.id,
    csrfToken: 'csrf',
    now,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { orderId, cookie: `topvpn_customer_session=${raw}`, customerId: customer.id };
}

describe('credential delivery', () => {
  it('is unavailable unless every dependency is configured', async () => {
    const a = await seed();
    const order = await getVpnOrder(testEnv.DB, a.orderId);
    const info = await buildConnectionInfo({ DB: testEnv.DB } as Env, order!);
    expect(info).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('refuses to deliver before the order is active', async () => {
    const a = await seed('pending');
    const order = await getVpnOrder(testEnv.DB, a.orderId);
    const info = await buildConnectionInfo(envWg(), order!, { provider: fakeProvider().provider });
    expect(info).toEqual({ ok: false, reason: 'not_active' });
  });

  it('returns the provider config to the owning customer with no-store headers', async () => {
    const a = await seed();
    const { provider } = fakeProvider();
    const request = new Request(`https://topvpn.test/account/orders/${a.orderId}/credentials`, {
      headers: { Cookie: a.cookie },
    });

    const res = await credentialsPage(request, envWg(), a.orderId, { provider });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('[Interface]');
    expect(html).toContain('PrivateKey=abc123');
    expect(html).not.toContain('provider-token-for-tests');

    const again = await credentialsPage(
      new Request(`https://topvpn.test/account/orders/${a.orderId}/credentials`, { headers: { Cookie: a.cookie } }),
      envWg(),
      a.orderId,
      { provider },
    );
    expect(again.status).toBe(200);
  });

  it('does not expose credentials without a customer session', async () => {
    const a = await seed();
    const { provider } = fakeProvider();
    const res = await credentialsPage(
      new Request(`https://topvpn.test/account/orders/${a.orderId}/credentials`),
      envWg(),
      a.orderId,
      { provider },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('[Interface]');
    expect(html).toContain('Sign-in email is not available yet');
  });

  it('denies cross-customer credential access with 404', async () => {
    const a = await seed();
    const b = await seed();
    const { provider } = fakeProvider();
    const res = await credentialsPage(
      new Request(`https://topvpn.test/account/orders/${b.orderId}/credentials`, { headers: { Cookie: a.cookie } }),
      envWg(),
      b.orderId,
      { provider },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('[Interface]');
  });

  it('maps a provider failure to a sanitized 502 without echoing provider text', async () => {
    const a = await seed();
    const order = await getVpnOrder(testEnv.DB, a.orderId);
    const { provider } = fakeProvider('error');
    const res = await credentialsPage(
      new Request(`https://topvpn.test/account/orders/${a.orderId}/credentials`, { headers: { Cookie: a.cookie } }),
      envWg(),
      a.orderId,
      { provider },
    );
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).not.toContain('bad gateway');
  });

  it('refuses delivery after the access period ends', async () => {
    const a = await seed();
    await testEnv.DB.prepare(`UPDATE vpn_orders SET expire_at='2020-01-01' WHERE id=?`).bind(a.orderId).run();
    const order = await getVpnOrder(testEnv.DB, a.orderId);
    const info = await buildConnectionInfo(envWg(), order!, { provider: fakeProvider().provider });
    expect(info).toEqual({ ok: false, reason: 'not_active' });
  });

  it('rate limits repeated credential retrieval per customer', async () => {
    const a = await seed();
    const { provider } = fakeProvider();
    let lastStatus = 200;

    for (let i = 0; i < 21; i++) {
      const res = await credentialsPage(
        new Request(`https://topvpn.test/account/orders/${a.orderId}/credentials`, {
          headers: { Cookie: a.cookie },
        }),
        envWg(),
        a.orderId,
        { provider },
      );
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('builds OpenVPN auth from the account username and derived password', async () => {
    const a = await seed();
    const order = await getVpnOrder(testEnv.DB, a.orderId);
    const { provider } = fakeProvider();
    const env = envWg({ VPN_WIREGUARD_SERVER_ID: '', VPN_OPENVPN_SERVER_ID: '8', VPN_OPENVPN_PORT_ID: '9' });
    const info = await buildConnectionInfo(env, order!, { provider });

    expect(info.ok).toBe(true);
    if (!info.ok) return;
    expect(info.protocol).toBe('openvpn');
    expect(info.username).toBe('topvpn-test');
    expect(info.password).toHaveLength(32);
    expect(JSON.stringify(info)).not.toContain('provider-token-for-tests');
  });
});
