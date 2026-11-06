/**
 * Connection-details delivery.
 *
 * Contract (VPNResellers v4.1, verified from the local API docs):
 *   GET /configuration/wireguard?server_id&account_id -> { content, name }
 *   GET /configuration/openvpn?server_id&port_id      -> { content, name }
 * Credentials are generated on demand and are NEVER stored in D1; WireGuard
 * configs are fetched from the provider, OpenVPN auth is the account username
 * plus the deterministically derived password (same derivation used on create).
 */
import type { Env } from '../env';
import {
  loadVpnResellersConfig,
  VpnResellersClient,
  type ProviderConfigPayload,
  type ProviderResult,
} from '../vpnresellers';
import { derivePassword } from './service';

export interface CredentialOrder {
  id: string;
  order_status: string;
  provisioning_status: string;
  provider_account_id: string | null;
  provider_username: string | null;
  expire_at: string | null;
}

export type ConnectionInfo =
  | {
      ok: true;
      protocol: 'wireguard' | 'openvpn';
      name: string;
      content: string;
      username?: string;
      password?: string;
    }
  | {
      ok: false;
      reason: 'not_configured' | 'not_active' | 'missing_account' | 'provider_error' | 'empty_config';
    };

export interface CredentialProvider {
  getWireguardConfig(serverId: number, accountId: number): Promise<ProviderResult<ProviderConfigPayload>>;
  getOpenVpnConfig(serverId: number, portId: number): Promise<ProviderResult<ProviderConfigPayload>>;
}

/**
 * Delivery is off unless explicitly enabled AND every dependency is present.
 * There is no fallback that could produce fabricated credentials.
 */
export function credentialDeliveryReady(env: Env): boolean {
  return (
    env.VPN_CREDENTIAL_DELIVERY_ENABLED === 'true' &&
    !!env.VPNRESELLERS_API_TOKEN &&
    !!env.VPN_PROVISIONING_SECRET &&
    (!!env.VPN_WIREGUARD_SERVER_ID || (!!env.VPN_OPENVPN_SERVER_ID && !!env.VPN_OPENVPN_PORT_ID))
  );
}

function positiveInt(value: string | undefined | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function configContent(data: ProviderConfigPayload | string | undefined): string | null {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && typeof data.content === 'string') return data.content;
  return null;
}

export async function buildConnectionInfo(
  env: Env,
  order: CredentialOrder,
  options: { provider?: CredentialProvider } = {},
): Promise<ConnectionInfo> {
  if (!credentialDeliveryReady(env)) return { ok: false, reason: 'not_configured' };
  if (order.order_status !== 'active' || order.provisioning_status !== 'succeeded') {
    return { ok: false, reason: 'not_active' };
  }
  // Never deliver past the paid period (no scheduled job marks orders expired).
  if (order.expire_at && order.expire_at.slice(0, 10) < new Date().toISOString().slice(0, 10)) {
    return { ok: false, reason: 'not_active' };
  }

  const accountId = positiveInt(order.provider_account_id);
  if (!accountId) return { ok: false, reason: 'missing_account' };

  let provider: CredentialProvider;
  if (options.provider) {
    provider = options.provider;
  } else {
    const config = loadVpnResellersConfig(env);
    if (!config.ok) return { ok: false, reason: 'not_configured' };
    provider = new VpnResellersClient(config.config);
  }

  const wireguardServer = positiveInt(env.VPN_WIREGUARD_SERVER_ID);
  if (wireguardServer) {
    const response = await provider.getWireguardConfig(wireguardServer, accountId);
    if (!response.ok) return { ok: false, reason: 'provider_error' };
    const content = configContent(response.data as ProviderConfigPayload | string);
    if (!content) return { ok: false, reason: 'empty_config' };
    const name = (response.data as ProviderConfigPayload)?.name || 'wireguard.conf';
    return { ok: true, protocol: 'wireguard', name, content };
  }

  const openvpnServer = positiveInt(env.VPN_OPENVPN_SERVER_ID);
  const openvpnPort = positiveInt(env.VPN_OPENVPN_PORT_ID);
  if (openvpnServer && openvpnPort && env.VPN_PROVISIONING_SECRET) {
    const response = await provider.getOpenVpnConfig(openvpnServer, openvpnPort);
    if (!response.ok) return { ok: false, reason: 'provider_error' };
    const content = configContent(response.data as ProviderConfigPayload | string);
    if (!content) return { ok: false, reason: 'empty_config' };
    const name = (response.data as ProviderConfigPayload)?.name || 'openvpn.ovpn';
    const password = await derivePassword(env.VPN_PROVISIONING_SECRET, order.id);
    return {
      ok: true,
      protocol: 'openvpn',
      name,
      content,
      username: order.provider_username ?? '',
      password,
    };
  }

  return { ok: false, reason: 'not_configured' };
}
