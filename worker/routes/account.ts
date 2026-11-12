/**
 * Customer account portal (server-rendered by the Worker).
 *
 * - Magic-link sign-in; no password.
 * - Customer sessions use their own table and cookie, never the admin session.
 * - Every order query is scoped to the authenticated customer in SQL.
 * - Checkout success/cancel pages never mutate an order; a redirect is not proof
 *   of payment.
 */
import type { Env } from '../env';
import { json } from './api';
import { PLANS, isPlanId } from '../../src/lib/plans';
import { timingSafeEqual } from '../auth';
import { bumpRateLimit } from '../db';
import {
  CUSTOMER_COOKIE,
  clearCustomerCookie,
  consumeMagicLink,
  customerAuthReady,
  customerCookie,
  exchangeGoogleCode,
  getCustomerSessionFromToken,
  googleAuthReady,
  googleAuthorizeUrl,
  logoutCustomer,
  randomToken,
  requestMagicLink,
  startCustomerSession,
  type CustomerSessionContext,
} from '../customer/auth';
import { findOrCreateCustomer, getCustomerByEmail } from '../customer/repo';
import { vpnCheckout, vpnPayPalCreate } from './vpn';
import {
  addTicketMessage,
  createTicket,
  getCustomerTicket,
  listTicketMessages,
  listTicketsForCustomer,
  setTicketStatus,
} from '../support/tickets';
import { buildConnectionInfo, credentialDeliveryReady, type CredentialProvider } from '../vpn/credentials';
import {
  getCustomerOrder,
  linkOrderByEmail,
  linkOrdersToCustomer,
  listCustomerOrders,
  type CustomerOrderRow,
} from '../customer/repo';
import { getVpnOrder } from '../vpn/repo';
import { checkRenewalEligibility } from '../vpn/renewal';

/* ---------- helpers ---------- */

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [cookieName, ...rest] = part.trim().split('=');
    if (cookieName === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

function cookieToken(request: Request): string | null {
  return readCookie(request, CUSTOMER_COOKIE);
}

const VERIFY_COOKIE = 'topvpn_verify';

function verifyCookie(value: string): string {
  return `${VERIFY_COOKIE}=${value}; Path=/account; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

function clearVerifyCookie(): string {
  return `${VERIFY_COOKIE}=; Path=/account; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function currentCustomer(request: Request, env: Env): Promise<CustomerSessionContext | null> {
  return getCustomerSessionFromToken(env, cookieToken(request));
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

const ORDER_LABEL: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  provisioning: 'Setting up',
  active: 'Active',
  provisioning_failed: 'Needs support',
  reconciliation_required: 'Under review',
  expired: 'Expired',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

const PAYMENT_LABEL: Record<string, string> = { unpaid: 'Unpaid', paid: 'Paid', refunded: 'Refunded' };
const PROVISION_LABEL: Record<string, string> = {
  none: 'Not started',
  claimed: 'Claimed',
  provisioning: 'In progress',
  succeeded: 'Ready',
  failed: 'Failed',
  reconciliation: 'Under review',
};

function planName(planId: string): string {
  return isPlanId(planId) ? PLANS[planId].name : planId;
}

function page(title: string, body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<title>${esc(title)} | TopVPN</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0B1020;color:#E6E8EE;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
  main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
  a{color:#F5D77A}
  h1{font-size:1.5rem;margin:.2rem 0 1rem}
  h2{font-size:1.05rem;margin:0 0 .5rem}
  .nav{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid #232A44;font-size:.9rem}
  .card{background:#11162A;border:1px solid #232A44;border-radius:10px;padding:16px;margin:12px 0}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#1D2440;margin:2px 6px 2px 0}
  .badge.ok{background:#0F2E24;color:#8CE3B8}
  .badge.warn{background:#33280F;color:#F5D77A}
  .badge.bad{background:#331418;color:#FF9AA6}
  .muted{color:#98A2B3;font-size:.9rem}
  label{display:block;margin:10px 0 4px;font-size:.9rem}
  input{width:100%;padding:10px;border-radius:8px;border:1px solid #2A3352;background:#0E1326;color:inherit}
  button{padding:10px 16px;border-radius:8px;border:0;background:#D4AF37;color:#0B1020;font-weight:600;cursor:pointer}
  button.secondary{background:transparent;border:1px solid #2A3352;color:#E6E8EE}
  table{width:100%;border-collapse:collapse}
  td,th{text-align:left;padding:8px 0;border-bottom:1px solid #232A44;font-size:.92rem;vertical-align:top}
  .row-actions{margin-top:8px}
</style>
</head>
<body>
<div class="nav"><a href="/">TopVPN</a><a href="/#plans">Plans</a><a href="/account">My VPN</a><a href="/account/support">Support</a></div>
<main>${body}</main>
<script src="/support/widget.js" defer></script>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      Vary: 'Cookie',
      ...extraHeaders,
    },
  });
}

function badge(label: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): string {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

function effectiveOrderStatus(order: CustomerOrderRow): string {
  if (order.order_status === 'active' && order.expire_at) {
    const today = new Date().toISOString().slice(0, 10);
    if (order.expire_at.slice(0, 10) < today) return 'expired';
  }
  return order.order_status;
}

function orderBadges(order: CustomerOrderRow): string {
  const status = effectiveOrderStatus(order);
  const orderTone =
    status === 'active'
      ? 'ok'
      : status === 'provisioning_failed' || status === 'cancelled' || status === 'expired'
        ? 'bad'
        : status === 'reconciliation_required' || status === 'pending_payment'
          ? 'warn'
          : '';
  return [
    badge(ORDER_LABEL[status] ?? status, orderTone as 'ok' | 'warn' | 'bad' | ''),
    badge(`Payment: ${PAYMENT_LABEL[order.payment_status] ?? order.payment_status}`),
    badge(`Setup: ${PROVISION_LABEL[order.provisioning_status] ?? order.provisioning_status}`),
  ].join('');
}

function header(session: CustomerSessionContext): string {
  return `<div class="nav" style="border:0;padding:0 0 12px">
    <span class="muted">Signed in as ${esc(session.email)}</span>
    <form method="post" action="/account/api/logout" style="margin-left:auto">
      <input type="hidden" name="csrf" value="${esc(session.csrfToken)}">
      <button class="secondary" type="submit">Sign out</button>
    </form>
  </div>`;
}

function signInPage(env: Env, message?: string): Response {
  const ready = customerAuthReady(env);
  const google = googleAuthReady(env);
  const body = `<h1>Your account</h1>
  ${headerlessNotice(message)}
  ${
    ready || google
      ? `<div class="card">
          <p>Enter your email and we will send a one-time sign-in link. No password needed.</p>
          <form method="post" action="/account/api/request-link">
            <label for="email">Email address</label>
            <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
            <p><button type="submit">Email me a sign-in link</button></p>
          </form>
          ${google ? `<p class="muted">or</p><form method="get" action="/account/auth/google"><button type="submit">Sign in with Google</button></form>` : ''}
        </div>`
      : `<div class="card">
          <h2>Sign-in email is not available yet</h2>
          <p>Customer sign-in requires a verified email sender, which is not configured in this environment yet.
          No email has been sent and no account was created.</p>
          <p><a href="/contact">Contact support</a> if you need help with an existing order.</p>
        </div>`
  }`;
  return page('Your account', body);
}

function headerlessNotice(message?: string): string {
  return message ? `<div class="card">${esc(message)}</div>` : '';
}

function amountSummary(order: CustomerOrderRow): string {
  if (order.discount_cents > 0 && order.original_amount_cents) {
    return `<s style="color:#98A2B3">${esc(money(order.original_amount_cents, order.currency))}</s> ${esc(money(order.amount_cents, order.currency))}`;
  }
  return esc(money(order.amount_cents, order.currency));
}

function buySection(session: CustomerSessionContext, env: Env): string {
  const sales = env.VPN_SALES_ENABLED === 'true';
  if (!sales) {
    return `<div class="card"><h2>Buy VPN</h2><p class="muted">Online checkout is not open yet. <a href="/#plans">See plans</a> or <a href="/contact">contact us</a> to get started.</p></div>`;
  }
  const monthly = PLANS.monthly;
  const paypal = env.PAYPAL_ENABLED === 'true';
  const planCard = (id: string, name: string, months: number, cents: number, intro?: { cents: number }) => `
    <div class="card">
      <h2>${esc(name)}</h2>
      <p style="font-size:1.3rem;margin:.2rem 0">
        ${
          intro
            ? `<s class="muted">${esc(money(monthly.regularCents, 'USD'))}</s> <strong>${esc(money(intro.cents, 'USD'))}</strong> <span class="badge warn">First month offer</span>`
            : `<strong>${esc(money(cents, 'USD'))}</strong>`
        }
      </p>
      <p class="muted">One-time payment for ${months} month${months === 1 ? '' : 's'}. No automatic renewal.</p>
      <form method="post" action="/account/buy">
        <input type="hidden" name="csrf" value="${esc(session.csrfToken)}">
        <input type="hidden" name="planId" value="${esc(id)}">
        <label for="coupon-${esc(id)}">Coupon code (optional)</label>
        <input id="coupon-${esc(id)}" name="couponCode" placeholder="e.g. FIRST-MONTH" autocomplete="off" style="max-width:240px">
        <p class="row-actions">
          <button type="submit" name="provider" value="stripe">Pay with card (Stripe)</button>
          ${paypal ? `<button class="secondary" type="submit" name="provider" value="paypal">Pay with PayPal</button>` : ''}
        </p>
      </form>
    </div>`;
  return `<h2>Buy VPN</h2>
  ${planCard('monthly', 'Monthly', monthly.intervalMonths, monthly.regularCents, { cents: monthly.introCents ?? monthly.regularCents })}
  ${planCard('annual', 'Annual', PLANS.annual.intervalMonths, PLANS.annual.regularCents)}
  ${planCard('two-year', 'Two-Year', PLANS['two-year'].intervalMonths, PLANS['two-year'].regularCents)}`;
}

function dashboard(session: CustomerSessionContext, orders: CustomerOrderRow[], env: Env): Response {
  const body = `<h1>Your account</h1>
  ${header(session)}
  <h2>Your orders</h2>
  ${
    orders.length === 0
      ? `<div class="card"><p>No orders yet.</p></div>`
      : orders
          .map(
            (order) => `<div class="card">
              <h2>${esc(planName(order.plan_id))} آ· ${amountSummary(order)}</h2>
              <div>${orderBadges(order)}</div>
              <p class="muted">Order ${esc(order.id)} آ· placed ${esc(order.created_at.slice(0, 10))}${order.payment_provider ? ' آ· ' + esc(order.payment_provider) : ''}</p>
              ${
                order.order_status === 'provisioning_failed' || order.order_status === 'reconciliation_required'
                  ? `<p class="muted">We are reviewing this order. <a href="/contact">Contact support</a> and include the order ID.</p>`
                  : ''
              }
              <p class="row-actions"><a href="/account/orders/${encodeURIComponent(order.id)}">View details</a></p>
            </div>`,
          )
          .join('')
  }
  ${buySection(session, env)}
  <h2>Support</h2>
  <div class="card">
    <p>Need help? Ask the assistant (bottom-right) or <a href="/account/support">open a support ticket</a>.</p>
  </div>`;
  return page('Your account', body);
}

function orderDetail(session: CustomerSessionContext, order: CustomerOrderRow, showCredentials: boolean): Response {
  const status = effectiveOrderStatus(order);
  const active = order.order_status === 'active' && order.provisioning_status === 'succeeded';
  const eligibility = checkRenewalEligibility(order, new Date());
  const renewalPrice = isPlanId(order.plan_id) ? PLANS[order.plan_id].regularCents : order.amount_cents;
  const body = `<h1>Order details</h1>
  ${header(session)}
  <div class="card">
    <h2>${esc(planName(order.plan_id))}</h2>
    <div>${orderBadges(order)}</div>
    <table>
      <tr><th>Order ID</th><td>${esc(order.id)}</td></tr>
      ${order.discount_cents > 0 && order.original_amount_cents ? `<tr><th>Original price</th><td><s>${esc(money(order.original_amount_cents, order.currency))}</s></td></tr>
      <tr><th>Discount</th><td>âˆ’${esc(money(order.discount_cents, order.currency))}${order.coupon_id ? ' (coupon applied)' : ''}</td></tr>` : ''}
      <tr><th>Amount paid</th><td>${esc(money(order.amount_cents, order.currency))}${order.payment_provider ? ' via ' + esc(order.payment_provider) : ''}</td></tr>
      <tr><th>Placed</th><td>${esc(order.created_at)}</td></tr>
      ${order.expire_at ? `<tr><th>Access until</th><td>${esc(order.expire_at)}</td></tr>` : ''}
      ${eligibility.days_remaining !== null ? `<tr><th>Days remaining</th><td>${eligibility.days_remaining}</td></tr>` : ''}
      ${eligibility.eligible ? `<tr><th>Renewal price</th><td>${esc(money(renewalPrice, order.currency))}</td></tr>` : ''}
    </table>
    ${
      active
        ? `<p class="muted">Your subscription is active.</p>${
            showCredentials
              ? `<p><a href="/account/orders/${encodeURIComponent(order.id)}/credentials">Connection details</a></p>`
              : ''
          }`
        : status === 'provisioning_failed' || status === 'reconciliation_required'
          ? `<p class="muted">This order needs a manual check. <a href="/contact">Contact support</a> with the order ID.</p>`
          : status === 'expired'
            ? `<p class="muted">This access period has ended. <a href="/#plans">View current plans</a> or <a href="/contact">contact support</a>.</p>`
            : status === 'refunded'
              ? `<p class="muted">This order was refunded. <a href="/contact">Contact support</a> if you have questions.</p>`
              : status === 'cancelled'
                ? `<p class="muted">This order was cancelled. <a href="/contact">Contact support</a> if you were charged.</p>`
                : ''
    }
    ${
      status === 'pending_payment'
        ? `<p class="muted">Payment is not confirmed yet. If you just paid, it may take a moment for the payment provider to notify us.</p>`
        : ''
    }
    ${
      eligibility.eligible
        ? `<form method="post" action="/api/vpn/orders/${encodeURIComponent(order.id)}/renew">
             <input type="hidden" name="csrf" value="${esc(session.csrfToken)}">
             <button type="submit">Renew now â€” ${esc(money(renewalPrice, order.currency))}</button>
             <p class="muted">Pay once. No automatic charge. Access extends from your current expiry date.</p>
           </form>`
        : eligibility.reason === 'not_in_window'
          ? `<p class="muted">Renewal opens within 30 days of expiry (${eligibility.days_remaining} days remaining).</p>`
          : ''
    }
  </div>
  <p><a href="/account">â†گ Back to your account</a></p>`;
  return page('Order details', body);
}

/* ---------- routes ---------- */

export async function accountPage(request: Request, env: Env): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env);
  // Orders can be created after sign-in (checkout is public). Re-link idempotently
  // so a verified customer always sees orders placed with their verified email.
  await linkOrdersToCustomer(env.DB, session.customerId, session.email, new Date().toISOString());
  const orders = await listCustomerOrders(env.DB, session.customerId);
  return dashboard(session, orders, env);
}

async function readField(request: Request, field: string): Promise<string> {
  const fields = await readFields(request, [field]);
  return fields[field] ?? '';
}

async function readFields(request: Request, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const contentType = request.headers.get('Content-Type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      for (const name of names) {
        if (typeof body[name] === 'string') out[name] = body[name] as string;
      }
      return out;
    }
    const form = await request.formData();
    for (const name of names) {
      const value = form.get(name);
      if (typeof value === 'string') out[name] = value;
    }
  } catch {
    // Return what was parsed (possibly nothing).
  }
  return out;
}

export async function requestLinkRoute(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const email = await readField(request, 'email');
  await requestMagicLink(env, { email, ip });

  const wantsJson = (request.headers.get('Content-Type') ?? '').includes('application/json');
  if (wantsJson) return json({ ok: true });
  return page(
    'Check your email',
    `<h1>Check your email</h1><div class="card"><p>If an account exists for that address, a sign-in link is on its way. The link expires in 15 minutes and works once.</p></div><p><a href="/account">Back</a></p>`,
  );
}

export async function verifyRoute(request: Request, _env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token || token.length > 512) {
    return page(
      'Link invalid',
      `<h1>This link is invalid or expired</h1><div class="card"><p>Sign-in links can be used once and expire after 15 minutes.</p><p><a href="/account">Request a new link</a></p></div>`,
      400,
    );
  }
  // A GET only renders a confirmation page. This keeps mail-scanner prefetch
  // from consuming the one-time token; consumption happens on the POST below.
  const confirm = randomToken(16);
  return page(
    'Sign in',
    `<h1>Sign in to TopVPN</h1>
    <div class="card">
      <p>Confirm you want to sign in to your TopVPN account. This link works once and expires in 15 minutes.</p>
      <form method="post" action="/account/verify">
        <input type="hidden" name="token" value="${esc(token)}">
        <input type="hidden" name="confirm" value="${esc(confirm)}">
        <button type="submit">Sign in</button>
      </form>
      <p class="muted">Opening this page does not sign you in.</p>
    </div>`,
    200,
    { 'Set-Cookie': verifyCookie(confirm) },
  );
}

export async function verifySubmitRoute(request: Request, env: Env): Promise<Response> {
  // Browsers label cross-site form posts; block them before touching the token.
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return page('Forbidden', `<h1>Could not sign you in</h1><div class="card"><p>The request could not be verified.</p></div>`, 403);
  }

  const fields = await readFields(request, ['token', 'confirm']);
  const token = fields.token ?? '';
  const confirm = fields.confirm ?? '';
  const cookie = readCookie(request, VERIFY_COOKIE);
  // Double-submit + SameSite=Lax blocks cross-site login CSRF.
  if (!confirm || !cookie || !timingSafeEqual(confirm, cookie)) {
    return page('Forbidden', `<h1>Could not sign you in</h1><div class="card"><p>The request could not be verified.</p><p><a href="/account">Request a new link</a></p></div>`, 403);
  }

  // Session rotation: remove any previous customer session before issuing a new one.
  const existing = cookieToken(request);
  if (existing) await logoutCustomer(env, existing);

  const result = await consumeMagicLink(env, token);
  if (!result.ok) {
    return page(
      'Link invalid',
      `<h1>This link is invalid or expired</h1><div class="card"><p>Sign-in links can be used once and expire after 15 minutes.</p><p><a href="/account">Request a new link</a></p></div>`,
      400,
    );
  }

  const headers = new Headers({
    Location: '/account',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  headers.append('Set-Cookie', customerCookie(result.session.sessionToken));
  headers.append('Set-Cookie', clearVerifyCookie());
  return new Response(null, { status: 303, headers });
}

export async function logoutRoute(request: Request, env: Env): Promise<Response> {
  const raw = cookieToken(request);
  const session = await currentCustomer(request, env);
  if (!session) {
    return new Response(null, { status: 303, headers: { Location: '/account', 'Set-Cookie': clearCustomerCookie() } });
  }
  const csrf = await readField(request, 'csrf');
  if (!csrf || !timingSafeEqual(csrf, session.csrfToken)) {
    return page('Forbidden', `<h1>Could not sign you out</h1><div class="card"><p>The request could not be verified.</p></div>`, 403);
  }
  await logoutCustomer(env, raw);
  return new Response(null, {
    status: 303,
    headers: { Location: '/account', 'Set-Cookie': clearCustomerCookie(), 'Cache-Control': 'no-store' },
  });
}

export async function accountOrderPage(request: Request, env: Env, orderId: string): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env);
  await linkOrderByEmail(env.DB, session.customerId, session.email, orderId, new Date().toISOString());
  const order = await getCustomerOrder(env.DB, session.customerId, orderId);
  if (!order) return page('Order not found', `<h1>Order not found</h1><p><a href="/account">Back to your account</a></p>`, 404);
  return orderDetail(session, order, credentialDeliveryReady(env));
}

export async function credentialsPage(
  request: Request,
  env: Env,
  orderId: string,
  deps: { provider?: CredentialProvider } = {},
): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env);
  await linkOrderByEmail(env.DB, session.customerId, session.email, orderId, new Date().toISOString());
  const owned = await getCustomerOrder(env.DB, session.customerId, orderId);
  if (!owned) return page('Order not found', `<h1>Order not found</h1><p><a href="/account">Back to your account</a></p>`, 404);

  const order = await getVpnOrder(env.DB, orderId);
  if (!order) return page('Order not found', `<h1>Order not found</h1><p><a href="/account">Back to your account</a></p>`, 404);

  const limit = await bumpRateLimit(env.DB, `vpn-credential:${session.customerId}`, 3600, 20);
  if (!limit.allowed) {
    return page(
      'Too many requests',
      `<h1>Too many requests</h1><div class="card"><p>Please wait before requesting connection details again.</p><p><a href="/account/orders/${encodeURIComponent(order.id)}">Back to order</a></p></div>`,
      429,
    );
  }

  const info = await buildConnectionInfo(env, order, deps);
  if (!info.ok) {
    const mapping = {
      not_configured: [503, 'Connection details are not available yet.'],
      not_active: [409, 'This order is not active yet.'],
      missing_account: [409, 'This order is not active yet.'],
      provider_error: [502, 'Connection details are temporarily unavailable.'],
      empty_config: [502, 'Connection details are temporarily unavailable.'],
    } as const;
    const [status, message] = mapping[info.reason];
    return page(
      'Connection details',
      `<h1>Connection details</h1><div class="card"><p>${esc(message)}</p><p><a href="/contact">Contact support</a> if this persists.</p></div><p><a href="/account/orders/${encodeURIComponent(order.id)}">Back to order</a></p>`,
      status,
    );
  }

  const protocol = info.protocol === 'wireguard' ? 'WireGuard' : 'OpenVPN';
  const auth =
    info.username && info.password
      ? `<table><tr><th>Username</th><td><code>${esc(info.username)}</code></td></tr><tr><th>Password</th><td><code>${esc(info.password)}</code></td></tr></table>`
      : '';
  return page(
    'Connection details',
    `<h1>Connection details</h1>
    <div class="card">
      <p class="muted">Treat this configuration like a password. Do not share it or paste it into untrusted sites.</p>
      <p><strong>${esc(protocol)}</strong> آ· ${esc(info.name)}</p>
      ${auth}
      <pre style="white-space:pre-wrap;word-break:break-all;background:#0E1326;padding:12px;border-radius:8px;border:1px solid #2A3352">${esc(info.content)}</pre>
    </div>
    <p><a href="/account/orders/${encodeURIComponent(order.id)}">Back to order</a></p>`,
  );
}

export async function checkoutSuccessPage(request: Request, env: Env): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) {
    return page(
      'Order status',
      `<h1>Sign in to see your order</h1><div class="card"><p>For your privacy, order details are only shown after you sign in.</p><p><a href="/account">Sign in</a></p></div>`,
    );
  }

  const orderId = new URL(request.url).searchParams.get('order') ?? '';
  if (orderId) {
    await linkOrderByEmail(env.DB, session.customerId, session.email, orderId, new Date().toISOString());
  }
  const order = orderId ? await getCustomerOrder(env.DB, session.customerId, orderId) : null;
  if (!order) {
    return page('Order not found', `<h1>Order not found</h1><p><a href="/account">Back to your account</a></p>`, 404);
  }

  const status = effectiveOrderStatus(order);
  const refunded = order.payment_status === 'refunded' || status === 'refunded';
  const cancelled = status === 'cancelled';
  const paid = order.payment_status === 'paid' && !refunded && !cancelled;
  const needsSupport =
    paid && (order.provisioning_status === 'failed' || order.provisioning_status === 'reconciliation');
  const title = refunded
    ? 'Order refunded'
    : cancelled
      ? 'Order cancelled'
      : paid
        ? 'Payment confirmed'
        : 'Waiting for payment confirmation';
  const note = refunded
    ? 'This order was refunded. If you have questions, contact support.'
    : cancelled
      ? 'This order was cancelled. If you were charged, contact support and we will help.'
      : needsSupport
        ? 'Your payment is confirmed. Account setup needs a manual check â€” our support team will help you finish it.'
        : paid
          ? 'Thank you. Your payment is confirmed and your order is being set up.'
          : 'We have not received payment confirmation yet. If you just paid, it can take a moment for the payment provider to notify us.';
  const body = `<h1>${esc(title)}</h1>
  ${header(session)}
  <div class="card">
    <h2>${esc(planName(order.plan_id))} آ· ${esc(money(order.amount_cents, order.currency))}</h2>
    <div>${orderBadges(order)}</div>
    <p>${esc(note)}</p>
    <p class="muted">Order ${esc(order.id)}</p>
  </div>
  <p><a href="/account">View your account</a></p>`;
  return page(title, body);
}

export async function checkoutCancelPage(): Promise<Response> {
  return page(
    'Payment not completed',
    `<h1>Payment was not completed</h1>
    <div class="card">
      <p>This checkout was cancelled. No payment was confirmed for it.</p>
      <p class="muted">If you did complete a payment, it may still be processing. Check your account before trying again.</p>
    </div>
    <p><a href="/#plans">Back to plans</a> آ· <a href="/account">Your account</a> آ· <a href="/contact">Contact support</a></p>`,
  );
}

/* ---------- buy VPN (server-rendered checkout start; no client JS) ---------- */

const OAUTH_STATE_COOKIE = 'topvpn_oauth_state';

export async function buyRoute(request: Request, env: Env): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env, 'Please sign in first.');

  const fields = await readFields(request, ['csrf', 'planId', 'couponCode', 'provider']);
  if (!fields.csrf || !timingSafeEqual(fields.csrf, session.csrfToken)) {
    return page('Forbidden', `<h1>Could not verify the request</h1><p><a href="/account">Back to your account</a></p>`, 403);
  }
  if (env.VPN_SALES_ENABLED !== 'true') {
    return page('Checkout closed', `<h1>Checkout is not open yet</h1><p><a href="/account">Back to your account</a></p>`, 503);
  }

  const planId = fields.planId;
  if (!isPlanId(planId)) return page('Unknown plan', `<h1>Unknown plan</h1><p><a href="/account">Back to your account</a></p>`, 422);
  const provider = fields.provider === 'paypal' ? 'paypal' : 'stripe';
  const couponCode = (fields.couponCode ?? '').trim();

  // Proxy through the public, fully-tested checkout handlers so sandbox gating,
  // idempotency, coupon and provider rules stay in exactly one place.
  const payload = JSON.stringify({
    email: session.email,
    planId,
    couponCode,
    idempotencyKey: randomToken(32),
  });
  const internal = new Request('https://internal.topvpn/api/vpn/checkout', {
    method: 'POST',
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') ?? '',
    },
  });
  const res = provider === 'paypal' ? await vpnPayPalCreate(internal, env) : await vpnCheckout(internal, env);
  const data = (await res.json().catch(() => ({}))) as { checkoutUrl?: string; approveUrl?: string; error?: string };

  if (res.ok && (data.checkoutUrl || data.approveUrl)) {
    return new Response(null, {
      status: 303,
      headers: { Location: (data.checkoutUrl ?? data.approveUrl) as string, 'Cache-Control': 'no-store' },
    });
  }
  return page(
    'Checkout could not start',
    `<h1>Checkout could not start</h1>
     <div class="card"><p>${esc(data.error ?? 'Please try again in a moment.')}</p>
     <p class="muted">No payment was taken.</p></div>
     <p><a href="/account">Back to your account</a></p>`,
    res.status >= 400 && res.status < 500 ? res.status : 502,
  );
}

/* ---------- Google (Gmail) sign-in ---------- */

export async function googleStartRoute(request: Request, env: Env): Promise<Response> {
  if (!googleAuthReady(env)) {
    return signInPage(env, 'Google sign-in is not configured in this environment yet. Use the email link instead.');
  }
  const state = randomToken(16);
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/account/auth/google/callback`;
  const url = googleAuthorizeUrl(env, redirectUri, state);
  const stateCookie = `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/account; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return new Response(null, {
    status: 303,
    headers: { Location: url, 'Set-Cookie': stateCookie, 'Cache-Control': 'no-store' },
  });
}

export async function googleCallbackRoute(
  request: Request,
  env: Env,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const cookieState = readCookie(request, OAUTH_STATE_COOKIE) ?? '';
  const fail = (message: string, status = 400): Response =>
    page('Sign-in failed', `<h1>Google sign-in failed</h1><div class="card"><p>${esc(message)}</p>
      <p><a href="/account">Try again</a></p></div>`, status);

  if (!code || !state || !cookieState || !timingSafeEqual(state, cookieState)) {
    return fail('The sign-in request could not be verified. Please start again.');
  }

  const origin = url.origin;
  const exchange = await exchangeGoogleCode(env, code, `${origin}/account/auth/google/callback`, deps);
  if (!exchange.ok) return fail('Google did not confirm your sign-in. Please try the email link instead.');
  if (!exchange.emailVerified) return fail('Your Google email address is not verified, so it cannot be used to sign in.');

  const email = exchange.email.toLowerCase().trim();
  const now = new Date();
  const existing = await getCustomerByEmail(env.DB, email);
  if (existing?.blocked_at) return fail('This account is blocked. Please contact support.', 403);

  const customer = existing ?? (await findOrCreateCustomer(env.DB, email, now.toISOString()));
  const session = await startCustomerSession(env, customer, now);
  const clearState = `${OAUTH_STATE_COOKIE}=; Path=/account; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const headers = new Headers({ Location: '/account', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', customerCookie(session.sessionToken));
  headers.append('Set-Cookie', clearState);
  return new Response(null, { status: 303, headers });
}

/* ---------- customer support tickets ---------- */

function ticketsPage(session: CustomerSessionContext, tickets: Awaited<ReturnType<typeof listTicketsForCustomer>>): Response {
  const rows = tickets
    .map(
      (t) => `<div class="card">
        <h2>${esc(t.subject)}</h2>
        <div>${badge(t.status, t.status === 'open' ? 'warn' : t.status === 'closed' ? '' : 'ok')}
             <span class="muted">updated ${esc(t.updated_at.slice(0, 16).replace('T', ' '))}</span></div>
        <p class="row-actions"><a href="/account/support/${encodeURIComponent(t.id)}">Open conversation</a></p>
      </div>`,
    )
    .join('');
  const body = `<h1>Support</h1>
  ${header(session)}
  <div class="card">
    <h2>New ticket</h2>
    <form method="post" action="/account/support">
      <input type="hidden" name="csrf" value="${esc(session.csrfToken)}">
      <label for="subject">Subject</label>
      <input id="subject" name="subject" required maxlength="140" placeholder="e.g. Cannot connect on Windows">
      <label for="tbody">Message</label>
      <textarea id="tbody" name="body" rows="5" required maxlength="5000" style="width:100%;padding:10px;border-radius:8px;border:1px solid #2A3352;background:#0E1326;color:inherit" placeholder="Describe the problem, and include an order ID if relevant."></textarea>
      <p><button type="submit">Open ticket</button></p>
    </form>
  </div>
  <h2>Your tickets</h2>
  ${rows || '<div class="card"><p class="muted">No tickets yet.</p></div>'}
  <p><a href="/account">â†گ Back to your account</a></p>`;
  return page('Support', body);
}

export async function supportPage(request: Request, env: Env): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env);
  const tickets = await listTicketsForCustomer(env.DB, session.customerId);
  return ticketsPage(session, tickets);
}

export async function createTicketRoute(request: Request, env: Env): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env, 'Please sign in first.');
  const fields = await readFields(request, ['csrf', 'subject', 'body']);
  if (!fields.csrf || !timingSafeEqual(fields.csrf, session.csrfToken)) {
    return page('Forbidden', `<h1>Could not verify the request</h1><p><a href="/account/support">Back</a></p>`, 403);
  }
  const subject = (fields.subject ?? '').trim();
  const text = (fields.body ?? '').trim();
  if (subject.length < 3 || subject.length > 140 || !text || text.length > 5000) {
    return page('Invalid ticket', `<h1>Ticket could not be created</h1>
      <div class="card"><p>A subject (3-140 characters) and a message (max 5000 characters) are required.</p></div>
      <p><a href="/account/support">Back</a></p>`, 422);
  }
  const now = new Date().toISOString();
  const ticket = await createTicket(env.DB, {
    customerId: session.customerId,
    email: session.email,
    subject,
    body: text,
    now,
  });
  return new Response(null, { status: 303, headers: { Location: `/account/support/${encodeURIComponent(ticket.id)}` } });
}

function ticketDetailPage(
  session: CustomerSessionContext,
  ticket: NonNullable<Awaited<ReturnType<typeof getCustomerTicket>>>,
  messages: Awaited<ReturnType<typeof listTicketMessages>>,
): Response {
  const thread = messages
    .map(
      (m) => `<div class="card">
        <p class="muted" style="margin:0 0 6px"><strong>${esc(m.author)}</strong> آ· ${esc(m.created_at.slice(0, 16).replace('T', ' '))}</p>
        <div style="white-space:pre-wrap">${esc(m.body)}</div>
      </div>`,
    )
    .join('');
  const replyForm =
    ticket.status === 'closed'
      ? `<div class="card"><p class="muted">This ticket is closed. Open a new ticket if you still need help.</p></div>`
      : `<div class="card">
          <form method="post" action="/account/support/${encodeURIComponent(ticket.id)}/reply">
            <input type="hidden" name="csrf" value="${esc(session.csrfToken)}">
            <label for="reply">Reply</label>
            <textarea id="reply" name="body" rows="4" required maxlength="5000" style="width:100%;padding:10px;border-radius:8px;border:1px solid #2A3352;background:#0E1326;color:inherit"></textarea>
            <p><button type="submit">Send reply</button></p>
          </form>
        </div>`;
  const body = `<h1>${esc(ticket.subject)}</h1>
  ${header(session)}
  <div>${badge(ticket.status, ticket.status === 'open' ? 'warn' : ticket.status === 'closed' ? '' : 'ok')}
       <span class="muted">Ticket ${esc(ticket.id)}</span></div>
  ${thread}
  ${replyForm}
  <p><a href="/account/support">â†گ All tickets</a></p>`;
  return page('Support ticket', body);
}

export async function ticketPage(request: Request, env: Env, ticketId: string): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env);
  const ticket = await getCustomerTicket(env.DB, session.customerId, ticketId);
  if (!ticket) return page('Ticket not found', `<h1>Ticket not found</h1><p><a href="/account/support">Back to support</a></p>`, 404);
  return ticketDetailPage(session, ticket, await listTicketMessages(env.DB, ticketId));
}

export async function ticketReplyRoute(request: Request, env: Env, ticketId: string): Promise<Response> {
  const session = await currentCustomer(request, env);
  if (!session) return signInPage(env, 'Please sign in first.');
  const ticket = await getCustomerTicket(env.DB, session.customerId, ticketId);
  if (!ticket) return page('Ticket not found', `<h1>Ticket not found</h1><p><a href="/account/support">Back</a></p>`, 404);

  const fields = await readFields(request, ['csrf', 'body']);
  if (!fields.csrf || !timingSafeEqual(fields.csrf, session.csrfToken)) {
    return page('Forbidden', `<h1>Could not verify the request</h1><p><a href="/account/support/${encodeURIComponent(ticketId)}">Back</a></p>`, 403);
  }
  const text = (fields.body ?? '').trim();
  if (!text || text.length > 5000) {
    return page('Invalid reply', `<h1>Reply could not be sent</h1><p><a href="/account/support/${encodeURIComponent(ticketId)}">Back</a></p>`, 422);
  }
  const now = new Date().toISOString();
  await addTicketMessage(env.DB, ticketId, 'customer', text, now);
  // Customer reply hands the ticket back to the team.
  await setTicketStatus(env.DB, ticketId, 'open', now);
  return new Response(null, { status: 303, headers: { Location: `/account/support/${encodeURIComponent(ticketId)}` } });
}
