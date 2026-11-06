/**
 * Worker entry point. Static assets (the Astro build in dist/) are served by
 * Cloudflare before this handler runs, so the Worker only receives API and
 * admin routes. See wrangler.ads.jsonc for bindings.
 */
import type { Env } from './env';
import {
  createOrder,
  health,
  issuePublicCsrf,
  json,
  publicOrderStatus,
  stripeWebhook,
} from './routes/api';
import {
  adminAddNote,
  adminCreative,
  adminListOrders,
  adminLogin,
  adminLogout,
  adminOrderDetail,
  adminPage,
  adminReplaceCreative,
  adminSessionInfo,
  adminSetApproval,
  adminSetCampaign,
} from './routes/admin';
import {
  createVpnOrderRoute,
  renewOrderRoute,
  vpnAdminOrder,
  vpnAdminProvision,
  vpnAdminRecover,
  vpnAdminRecoveryList,
  vpnAdminReconcile,
  vpnCheckout,
  vpnPlans,
  vpnStripeWebhook,
} from './routes/vpn';
import {
  accountOrderPage,
  accountPage,
  checkoutCancelPage,
  checkoutSuccessPage,
  credentialsPage,
  logoutRoute,
  requestLinkRoute,
  verifyRoute,
  verifySubmitRoute,
} from './routes/account';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    try {
      /* ---- public advertising API ---- */
      if (path === '/api/ads/health' && method === 'GET') return await health(env);
      if (path === '/api/ads/csrf' && method === 'GET') return await issuePublicCsrf(env);
      if (path === '/api/ads/orders' && method === 'POST') return await createOrder(request, env, ctx);
      if (path === '/api/ads/webhook' && method === 'POST') return await stripeWebhook(request, env, ctx);

      /* ---- VPN sales API (sandbox; flag-gated) ---- */
      if (path === '/api/vpn/plans' && method === 'GET') return await vpnPlans(env);
      if (path === '/api/vpn/orders' && method === 'POST') return await createVpnOrderRoute(request, env);
      const renewMatch = path.match(/^\/api\/vpn\/orders\/([^/]+)\/renew$/);
      if (renewMatch && method === 'POST') return await renewOrderRoute(request, env, renewMatch[1]);
      if (path === '/api/vpn/checkout' && method === 'POST') return await vpnCheckout(request, env);
      if (path === '/api/vpn/webhook' && method === 'POST') return await vpnStripeWebhook(request, env);

      const vpnAdminOrderMatch = path.match(/^\/admin\/api\/vpn\/orders\/([^/]+)$/);
      if (vpnAdminOrderMatch && method === 'GET') return await vpnAdminOrder(request, env, vpnAdminOrderMatch[1]);

      const vpnReconcileMatch = path.match(/^\/admin\/api\/vpn\/orders\/([^/]+)\/reconcile$/);
      if (vpnReconcileMatch && method === 'POST') return await vpnAdminReconcile(request, env, vpnReconcileMatch[1]);

      const vpnProvisionMatch = path.match(/^\/admin\/api\/vpn\/orders\/([^/]+)\/provision$/);
      if (vpnProvisionMatch && method === 'POST') return await vpnAdminProvision(request, env, vpnProvisionMatch[1]);

      if (path === '/admin/api/vpn/recovery' && method === 'GET') return await vpnAdminRecoveryList(request, env);

      const vpnRecoverMatch = path.match(/^\/admin\/api\/vpn\/orders\/([^/]+)\/recover$/);
      if (vpnRecoverMatch && method === 'POST') return await vpnAdminRecover(request, env, vpnRecoverMatch[1]);

      /* ---- customer account portal (magic-link; separate from admin) ---- */
      if (path === '/account' && method === 'GET') return await accountPage(request, env);
      if (path === '/account/api/request-link' && method === 'POST') return await requestLinkRoute(request, env);
      if (path === '/account/verify' && method === 'GET') return await verifyRoute(request, env);
      if (path === '/account/verify' && method === 'POST') return await verifySubmitRoute(request, env);
      if (path === '/account/api/logout' && method === 'POST') return await logoutRoute(request, env);

      const credentialsMatch = path.match(/^\/account\/orders\/([^/]+)\/credentials$/);
      if (credentialsMatch && method === 'GET') return await credentialsPage(request, env, credentialsMatch[1]);

      const accountOrderMatch = path.match(/^\/account\/orders\/([^/]+)$/);
      if (accountOrderMatch && method === 'GET') return await accountOrderPage(request, env, accountOrderMatch[1]);

      if (path === '/checkout/success' && method === 'GET') return await checkoutSuccessPage(request, env);
      if (path === '/checkout/cancel' && method === 'GET') return await checkoutCancelPage();

      const statusMatch = path.match(/^\/api\/ads\/orders\/([^/]+)$/);
      if (statusMatch && method === 'GET') return await publicOrderStatus(env, statusMatch[1]);

      /* ---- admin ---- */
      if (path === '/admin') return await adminPage(request, env);
      if (path === '/admin/api/session' && method === 'GET') return await adminSessionInfo(request, env);
      if (path === '/admin/api/login' && method === 'POST') return await adminLogin(request, env);
      if (path === '/admin/api/logout' && method === 'POST') return await adminLogout(request, env);
      if (path === '/admin/api/orders' && method === 'GET') return await adminListOrders(request, env);

      const detailMatch = path.match(/^\/admin\/api\/orders\/([^/]+)$/);
      if (detailMatch && method === 'GET') return await adminOrderDetail(request, env, detailMatch[1]);

      const actionMatch = path.match(/^\/admin\/api\/orders\/([^/]+)\/(creative|approval|campaign|note)$/);
      if (actionMatch) {
        const [, id, action] = actionMatch;
        if (action === 'creative' && method === 'GET') return await adminCreative(request, env, id);
        if (action === 'approval' && method === 'POST') return await adminSetApproval(request, env, id);
        if (action === 'campaign' && method === 'POST') return await adminSetCampaign(request, env, id);
        if (action === 'note' && method === 'POST') return await adminAddNote(request, env, id);
      }

      // Creative replace: the admin retry path for a failed optimization.
      const replaceMatch = path.match(/^\/admin\/api\/orders\/([^/]+)\/creative\/replace$/);
      if (replaceMatch && method === 'POST') return await adminReplaceCreative(request, env, replaceMatch[1]);

      // No API/admin route matched. GET/HEAD go to the asset layer so unmatched
      // URLs keep the Astro-generated branded 404 page with a 404 status, exactly
      // as the assets-only Worker did before this one existed. The asset layer
      // never re-invokes this Worker, so there is no loop. Other methods are not
      // served by assets, so they get a plain 404 for the unknown route.
      if (request.method === 'GET' || request.method === 'HEAD') {
        try {
          return await env.ASSETS.fetch(request);
        } catch {
          // Assets are always deployed alongside this Worker; if the layer is
          // somehow unavailable, still answer 404 instead of leaking a 500.
          return new Response('Not Found', { status: 404 });
        }
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('topvpn: unhandled error');
      return json({ error: 'Internal server error.' }, 500);
    }
  },
};
