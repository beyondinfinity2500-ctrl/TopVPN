# Advertising system — setup guide

The `/advertise` page pricing table, order form and terms, plus the ordering,
payment and admin back-end for TopVPN.

## Architecture

| Layer | Location | Notes |
|---|---|---|
| Pricing/limits (single source of truth) | `src/lib/ads/pricing.ts` | Imported by the Astro build (table display) **and** by the Worker (authoritative server-side price) |
| `/advertise` page | `src/pages/advertise.astro` + `src/components/ads/*` | Pricing table, single-step order form, terms/refund policy |
| Order form client script | `src/scripts/order-form.ts` | Live summary, CSRF fetch, Stripe redirect, status polling |
| Worker (API + admin) | `worker/` | Entry `worker/index.ts`, routes in `worker/routes/` |
| Database schema | `migrations/0001_ads_init.sql` | Orders, webhook idempotency, admin sessions, rate limits |
| Worker config | `wrangler.ads.jsonc` | D1 + R2 bindings; **placeholder database id on purpose** |

Request flow:

1. Client `GET /api/ads/csrf` → stateless HMAC token (24h).
2. Client `POST /api/ads/orders` (multipart) → server validates every field,
   **re-calculates the price from `pricing.ts`** (a client amount is never
   read), optimizes the image to WebP via the Cloudflare Images binding and
   stores only that optimized output in R2 (or stores text copy), inserts a
   pending order, then creates a Stripe Checkout Session for the exact contract
   amount with the internal order id as `metadata[order_id]` +
   `client_reference_id`.
3. Client is redirected to Stripe Checkout. The redirect is **never** treated
   as proof of payment: on return, the page polls `GET /api/ads/orders/:id`,
   which only reports `paid` after a signature-verified webhook.
4. Stripe `POST /api/ads/webhook` → HMAC-SHA256 signature verification +
   timestamp/replay check → idempotent processing (event id logged once) →
   `payment_status` transitions. Paid is only ever set here.
5. Emails via Resend to the customer and the admin; delivery status is recorded
   on the order (`sent` / `failed:*` / `not_configured`) and never faked.

Admin dashboard at `/admin/`: password login (PBKDF2), D1 sessions in
HttpOnly/Secure/SameSite=Strict cookies, CSRF token per session on every
state-changing action, rate-limited logins. Approve/reject creatives, set
campaign status (with auto-computed end date), add internal notes, preview
creatives (admin-only; R2 objects are never publicly addressed), and re-run
optimization for a failed creative via the replace action. There is
deliberately **no** endpoint that sets payment status.

### Creative optimization rules

- Allowed uploads: static **PNG, JPEG or WebP** up to **5 MB**. Animated images
  (GIF, animated WebP, APNG) are rejected explicitly — never silently reduced
  to a first frame. SVG and anything undecodable are rejected with HTTP 400 and
  no order or R2 object is created.
- The Images binding transcodes to **WebP at quality 80**, caps width at
  **1600 px** with `fit: 'scale-down'` (aspect ratio preserved, never
  upscaled). Only successfully optimized output is stored; an unoptimized
  original is never written to R2.
- If the Images service is over quota or unavailable, the order is still saved
  with `creative_status = failed` and a clear admin-visible error, and **no**
  unoptimized original is stored. The admin retries from `/admin/` (CSRF
  protected); payment and approval are untouched.
- The binding is defined only in `wrangler.ads.jsonc` (`images` → `IMAGES`).
  The Free plan includes 5,000 unique transformations/month; beyond that the
  service rejects rather than silently charging. No paid plan is enabled.

## 1. Create the D1 database and R2 bucket

```bash
npx wrangler d1 create topvpn-ads
npx wrangler r2 bucket create topvpn-ad-creatives
```

Copy the `database_id` printed by the first command into `wrangler.ads.jsonc`
(replacing `REPLACE_WITH_D1_DATABASE_ID`). Until you do this, `wrangler deploy`
for the ads config fails safely rather than deploying a half-configured worker.

## 2. Apply migrations

```bash
npm run db:migrate:remote   # production D1
npm run db:migrate:local    # local dev D1 (.wrangler/)
```

## 3. Stripe

1. Get your secret key from <https://dashboard.stripe.com/apikeys>.
2. Create the webhook endpoint in the Stripe dashboard pointing at
   `https://www.topvpn.top/api/ads/webhook` with these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
3. Set the secrets:

```bash
npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.ads.jsonc
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.ads.jsonc
```

The webhook URL is **not** registered anywhere in this repo — it must be added
in the Stripe dashboard. Until then, `GET /api/ads/health` reports
`stripe: false` and orders return 503 (the order is still stored; the customer
is told we will be in touch).

## 4. Crypto / stablecoin payments

**Not configured.** `checkoutSessionParams()` sends
`payment_method_types: ['card']` unless `STRIPE_CRYPTO_ENABLED === 'true'`.
Crypto is only advertised once you have verified with Stripe that your account
is eligible for stablecoin payments; then add to `wrangler.ads.jsonc` `vars`:

```jsonc
"STRIPE_CRYPTO_ENABLED": "true"
```

## 5. Email (Resend)

```bash
npx wrangler secret put RESEND_API_KEY --config wrangler.ads.jsonc
```

Requires a verified sending domain for the `EMAIL_FROM` address
(`ads@topvpn.top` by default — see `wrangler.ads.jsonc` `vars`). With no key,
orders record `not_configured` as the email status and nothing is pretended to
be delivered. `EMAIL_FROM` should use a domain you control and have verified in
Resend; `topvpn.top` is assumed.

## 6. Admin access

Generate a password hash (the password itself is never stored anywhere):

```bash
npm run admin:hash "your-strong-password"
npx wrangler secret put ADMIN_PASSWORD_HASH --config wrangler.ads.jsonc
```

Also set the random session/CSRF signing secret:

```bash
npx wrangler secret put SESSION_SECRET --config wrangler.ads.jsonc
```

Then sign in at `https://www.topvpn.top/admin/`. Admin notifications go to
`ADMIN_EMAIL` (`beyondinfinity2500@gmail.com` by default in `wrangler.ads.jsonc`).

## 7. Local development

```bash
cp .dev.vars.example .dev.vars       # fill in test keys
npm run db:migrate:local
npx wrangler dev --config wrangler.ads.jsonc --local
```

## 8. Deploy

```bash
npm run deploy:ads     # astro build && wrangler deploy --config wrangler.ads.jsonc
```

> **Important:** both `wrangler.jsonc` and `wrangler.ads.jsonc` use the same
> worker name, `topvpn`. The ads config is a **superset**: it serves the same
> static assets from `dist/` **and** adds `/api/ads/*` + `/admin/*` with the
> D1/R2 bindings. Once the advertising system is live, deploy **only** with
> `npm run deploy:ads`. Running the older `npm run deploy` (assets-only config)
> afterwards would strip the API routes and bindings from the live worker.

## 9. Tests

```bash
npm test          # full suite in the Workers runtime (miniflare, real D1/R2/Images)
npm run typecheck # astro check + tsc for the Worker
```

Covered: every price/duration combination, full-site bundle discount math,
server-side price calculation (client amounts ignored), form and upload
validation (MIME + extension + magic bytes + size + animation), CSRF, rate
limits, admin authentication/authorisation, webhook signature verification,
webhook duplicates, expired/failed sessions, prevention of unverified orders
becoming paid, public access being blocked for order data and creatives,
image optimization to WebP (dimension cap, aspect ratio, no upscale), corrupt
and spoofed uploads, quota-failure handling, and the admin replace path.

## 10. Remaining setup checklist

- [ ] Create D1 database, paste the real `database_id` into `wrangler.ads.jsonc`
- [ ] Create R2 bucket
- [ ] Apply remote migrations
- [ ] Set secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
      `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`
- [ ] Register the webhook endpoint in Stripe (see URL and events in section 3)
- [ ] Verify the Resend sending domain for `EMAIL_FROM`
- [ ] **Confirm** the legal entity details flagged in the terms section
      (registered name, address, registration number, tax details, governing
      jurisdiction) and add them to `src/components/ads/AdTerms.astro`
- [ ] (Optional) Verify Stripe crypto eligibility, then set
      `STRIPE_CRYPTO_ENABLED`
- [ ] (Optional) Add Cloudflare Turnstile to the order form for extra bot protection

Nothing in this repo is committed or pushed; nothing has been deployed. The
system reports `stripe: false` / `email: false` via the health endpoint until
the secrets exist.
