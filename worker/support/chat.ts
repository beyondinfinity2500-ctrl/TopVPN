/**
 * Rule-based support assistant (local test adapter for the DocFlare-style
 * chat widget).
 *
 * Why not the full DocFlare AI: it is a standalone Cloudflare Worker requiring
 * its own Vectorize index, Workers AI bindings, a crawler and a Bun toolchain.
 * It cannot run inside this Worker without new paid bindings and an indexing
 * pipeline. Per the restoration rules it is therefore reimplemented as a
 * lightweight in-stack adapter with the same UX contract (floating launcher,
 * on-demand loading, graceful fallback). Swapping in Workers AI/Vectorize later
 * only replaces `answerSupportQuestion` — the route and widget stay unchanged.
 *
 * Safety rules:
 *   - No external API calls, no credits, no network. Works fully offline.
 *   - NEVER returns credentials, configs or another customer's data; account
 *     questions point to the authenticated /account pages instead.
 *   - AI-style guidance is always labelled as guidance, not account truth.
 */

export interface SupportAnswer {
  reply: string;
  /** Suggests opening a support ticket when the rule set cannot help. */
  ticketSuggestion: boolean;
}

const TICKET_OFFER =
  '\n\nIf this did not solve it, open a support ticket from your account page and we will help you directly.';

function guide(platform: string, steps: string[]): SupportAnswer {
  return {
    reply: `Setting up TopVPN on ${platform}:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nYour personal config and QR code are on the order page under My VPN Services (sign in at /account).`,
    ticketSuggestion: false,
  };
}

interface Intent {
  match: RegExp;
  answer: SupportAnswer;
}

const INTENTS: Intent[] = [
  {
    match: /android/i,
    answer: guide('Android', [
      'Install the official WireGuard app from Google Play.',
      'Open My VPN Services in your TopVPN account and download the config or scan the QR code.',
      'In the WireGuard app tap + → Import from file or QR code.',
      'Tap the tunnel name to connect; the key icon means you are protected.',
    ]),
  },
  {
    match: /iphone|ipad|ios/i,
    answer: guide('iPhone/iPad', [
      'Install WireGuard from the App Store.',
      'Open My VPN Services in your TopVPN account and download the config or scan the QR code.',
      'In WireGuard tap + → Create from QR code (or import the file).',
      'Allow the VPN configuration, then toggle the tunnel on.',
    ]),
  },
  {
    match: /windows|pc\b/i,
    answer: guide('Windows', [
      'Download the official WireGuard client from wireguard.com/install.',
      'Open My VPN Services in your TopVPN account and download the tunnel config file.',
      'In WireGuard choose Import tunnel(s) from file and pick the downloaded file.',
      'Click Activate to connect.',
    ]),
  },
  {
    match: /mac\b|macos|apple computer/i,
    answer: guide('macOS', [
      'Install WireGuard from the Mac App Store.',
      'Open My VPN Services in your TopVPN account and download the tunnel config file.',
      'In WireGuard use File → Import tunnel from file.',
      'Click Activate; macOS asks for permission to add a VPN configuration once.',
    ]),
  },
  {
    match: /slow|speed|lag|buffering/i,
    answer: {
      reply:
        'For slow speeds try, in this order:\n' +
        '1. Switch to another server location in the app.\n' +
        '2. Use the WireGuard protocol (faster than OpenVPN).\n' +
        '3. Test on another network to rule out your ISP or Wi‑Fi.\n' +
        '4. Close background apps that stream or sync in the background.' +
        TICKET_OFFER,
      ticketSuggestion: true,
    },
  },
  {
    match: /cannot connect|can'?t connect|not connecting|connect fails|disconnect|drops?/i,
    answer: {
      reply:
        'Connection troubleshooting checklist:\n' +
        '1. Check that your subscription is Active on the My VPN Services page.\n' +
        '2. Re-import a fresh config file — configs can expire with the service.\n' +
        '3. Try a different server or network (mobile data instead of Wi‑Fi).\n' +
        '4. Restart the VPN app after any change.' +
        TICKET_OFFER,
      ticketSuggestion: true,
    },
  },
  {
    match: /renew|extend|expir/i,
    answer: {
      reply:
        'Renewals are always manual — TopVPN never charges you automatically:\n' +
        '1. Sign in at /account.\n' +
        '2. Open My VPN Services; the Renew button appears in the last 30 days before expiry.\n' +
        '3. Pay once and your expiry date is extended by the plan length. No subscription is created.',
      ticketSuggestion: false,
    },
  },
  {
    match: /order status|my order|where is my order|receipt|invoice/i,
    answer: {
      reply:
        'You can see every order, its payment status and its receipt details under My Orders after signing in at /account. Provisioning starts automatically once payment is confirmed; if an order is stuck for more than a few minutes it is flagged for our team automatically.',
      ticketSuggestion: true,
    },
  },
  {
    match: /refund|money back/i,
    answer: {
      reply:
        'Refunds are handled case by case by our team. Open a ticket from the Support section in your account with your order id and the reason, and we will review it. Refund events also appear on the order page automatically once processed.',
      ticketSuggestion: true,
    },
  },
  {
    match: /price|cost|how much|plan|pricing|\$9|\$3/i,
    answer: {
      reply:
        'Current one-time prices: Monthly $9 (first month $3 for new customers with the FIRST‑MONTH offer), Annual $72, Two‑Year $120. Every payment is one-time — there is no subscription and nothing is ever charged automatically. A new period always requires a new manual order.',
      ticketSuggestion: false,
    },
  },
  {
    match: /password|credential|config file|qr code|username/i,
    answer: {
      reply:
        'For your security I cannot show credentials in chat. Sign in at /account, open My VPN Services → the order, and use the connection-details page to copy or download your personal config and QR code.',
      ticketSuggestion: false,
    },
  },
  {
    match: /sign ?in|log ?in|login|magic link|email link|google/i,
    answer: {
      reply:
        'Sign in at /account: enter your email and we send a one-time link valid for 15 minutes (or use Sign in with Google when available). If no link arrives, check spam and wait a minute between attempts. If your account was blocked you will see a notice after trying to verify.',
      ticketSuggestion: true,
    },
  },
  {
    match: /wireguard|openvpn|protocol/i,
    answer: {
      reply:
        'TopVPN supports WireGuard (recommended: faster and modern) and OpenVPN. Configs for both are generated on your order page under My VPN Services after sign-in at /account.',
      ticketSuggestion: false,
    },
  },
];

const FALLBACK: SupportAnswer = {
  reply:
    'I can help with VPN setup (Android, iOS, Windows, macOS), connection problems, orders, renewals, prices and account access. Could you rephrase your question? You can also open a support ticket and our team will reply by email.',
  ticketSuggestion: true,
};

export function answerSupportQuestion(message: string): SupportAnswer {
  const text = (message ?? '').trim();
  if (!text) return FALLBACK;
  for (const intent of INTENTS) {
    if (intent.match.test(text)) return intent.answer;
  }
  return FALLBACK;
}
