# TopVPN — Operational Runbook (VPN Sales Sandbox)

**Purpose:** Controlled, test-mode activation path for the TopVPN Premium VPN sales
foundation. **No live payments, no real emails, no real provider accounts.**
All steps below are local/sandbox-only until explicitly authorized.

> ⚠️ Security: Never paste API keys, webhook secrets, or tokens into chat, Git, logs,
> or this document. This file contains only names and procedures, never values.

---

## 1. Configuration reference (names only — never values)

| Purpose | Variable | Required for | Local status |
|---|---|---|---|
| Stripe secret key (test only) | `STRIPE_SECRET_KEY` | Checkout session creation | MISSING |
| Stripe webhook signing secret (ads) | `STRIPE_WEBHOOK_SECRET` | Ads webhook verification | EMPTY (example-only) |
| Stripe webhook signing secret (VPN) | `STRIPE_VPN_WEBHOOK_SECRET` | VPN webhook verification | MISSING |
| Resend API key | `RESEND_API_KEY` | Magic-link email delivery | EMPTY (example-only) |
| Customer email sender | `CUSTOMER_EMAIL_FROM` | Magic-link sender address | MISSING |
| VPN sales enable | `VPN_SALES_ENABLED=true` | Order creation endpoint | MISSING |
| VPN sandbox checkout | `VPN_SANDBOX_CHECKOUT_ENABLED=true` | Stripe Checkout for VPN | MISSING |
| Customer auth enable | `VPN_CUSTOMER_AUTH_ENABLED=true` | Magic-link sign-in flow | MISSING |
| Credential delivery enable | `VPN_CREDENTIAL_DELIVERY_ENABLED=true` | Connection-details page | MISSING |
| VPNResellers API token | `VPNRESELLERS_API_TOKEN` | Account provisioning | MISSING |
| VPNResellers project ID | `VPNRESELLERS_PROJECT_ID` | Linked customer creation | MISSING |
| VPN provisioning secret | `VPN_PROVISIONING_SECRET` | Derive customer account passwords | MISSING |
| WireGuard server ID | `VPN_WIREGUARD_SERVER_ID` | WireGuard config retrieval | MISSING |
| OpenVPN server ID | `VPN_OPENVPN_SERVER_ID` | OpenVPN config retrieval | MISSING |
| OpenVPN port ID | `VPN_OPENVPN_PORT_ID` | OpenVPN config retrieval | MISSING |

**How to check locally (no values exposed):**
```
# shell — reports only SET / MISSING / EMPTY, never values
for k in STRIPE_SECRET_KEY STRIPE_VPN_WEBHOOK_SECRET RESEND_API_KEY VPNRESELLERS_API_TOKEN ...; do ... done
```

**Remote Cloudflare status:** UNKNOWN — no external API calls were made in this phase.
Secret presence in Cloudflare Workers cannot be inferred from local configuration.

---

## 2. Ads vs VPN separation

| Concern | Ads system | VPN sales |
|---|---|---|
| Stripe secret key | `STRIPE_SECRET_KEY` (shared name) | `STRIPE_SECRET_KEY` (shared name) |
| Stripe webhook secret | `STRIPE_WEBHOOK_SECRET` | `STRIPE_VPN_WEBHOOK_SECRET` (separate) |
| Webhook path | `/api/ads/webhook` | `/api/vpn/webhook` |
| Order table | `ads_orders` | `vpn_orders` |
| Metadata domain | (ads orders) | `domain=vpn` |
| Order ID prefix | `ORD-` | `ORD-VPN-` |

**Finding:** Routes and webhook secrets are separate. The Stripe *account* (`STRIPE_SECRET_KEY`) is shared by name, which is an operational dependency, not a code defect. VPN explicitly refuses `sk_live_` keys and requires `sk_test_`.

---

## 3. Controlled sandbox test sequence

**Prerequisites (all must be set locally before starting):**
- `VPN_SALES_ENABLED=true`
- `VPN_SANDBOX_CHECKOUT_ENABLED=true`
- `STRIPE_SECRET_KEY` = a `sk_test_...` key (never `sk_live_`)
- `STRIPE_VPN_WEBHOOK_SECRET` = a Stripe webhook signing secret for the VPN endpoint

**Steps:**
1. `npm run typecheck` and `npm run build` must pass.
2. Start local dev: `npx wrangler dev --config wrangler.ads.jsonc --local` (read-only local Worker).
3. `POST /api/vpn/plans` → verify catalog returns `checkout: "sandbox"` and server-computed amounts.
4. `POST /api/vpn/checkout` with a valid idempotency key (32–64 chars) → expect `201` with a Stripe Checkout URL.
5. Open the checkout URL in a browser; complete payment using a **Stripe test card** (e.g. `4242424242424242`).
6. Stripe sends `checkout.session.completed` to `/api/vpn/webhook` → verify signature, verify amount/currency match the order, mark order `paid`, provisioning enters `provisioning_failed` (no VPNResellers credentials configured) — **expected**: no account created, order stays paid.
7. `POST /admin/api/vpn/orders/:id/reconcile` (admin session + CSRF) → `still_missing` until provider credentials exist.
8. `POST /api/vpn/webhook` with a `charge.refunded` event (`amount_refunded` = full amount) → order becomes `refunded`.
9. Replay the same webhook event ID → `duplicate: true`, no state change.
10. Stop local Worker.

**Never:** use a real card, enable `sk_live_`, create a real VPNResellers account, or send a real email.

---

## 4. Steps before enabling public checkout (require explicit approval)

- [ ] `STRIPE_SECRET_KEY` = a `sk_test_...` key (never `sk_live_`)
- [ ] `STRIPE_VPN_WEBHOOK_SECRET` configured
- [ ] `VPN_SALES_ENABLED=true` and `VPN_SANDBOX_CHECKOUT_ENABLED=true` set locally only
- [ ] A full sandbox test sequence above completed successfully
- [ ] `VPNRESELLERS_API_TOKEN` + `VPNRESELLERS_PROJECT_ID` + `VPN_PROVISIONING_SECRET` configured (for provisioning)
- [ ] `RESEND_API_KEY` + `CUSTOMER_EMAIL_FROM` configured + sender domain verified (for customer auth emails)
- [ ] `VPN_CUSTOMER_AUTH_ENABLED=true` + `VPN_CREDENTIAL_DELIVERY_ENABLED=true` (for customer portal/credentials)
- [ ] Explicit product decision on post-refund access policy (retain / revoke / manual review)
- [ ] Explicit user approval to enable public checkout

---

## 5. Do NOT

- Print, paste, or commit any secret value.
- Use `sk_live_...` keys in the sandbox.
- Make live charges or refunds.
- Create, disable, or delete real VPNResellers accounts.
- Send real emails.
- Enable `VPN_SALES_ENABLED` or `VPN_SANDBOX_CHECKOUT_ENABLED` on production without explicit approval.
- Apply migrations to the shared/production D1 database.

---

## 6. If something fails

| Symptom | Likely cause | Next step |
|---|---|---|
| `503 Webhook not configured` | `STRIPE_VPN_WEBHOOK_SECRET` missing | Set locally, restart Worker |
| `503 VPN checkout is not available` | `VPN_SANDBOX_CHECKOUT_ENABLED` not `true` or key not `sk_test_` | Check env + key prefix |
| `409 Idempotency key ...` | Same key, different email/plan | Use a new key or same email+plan |
| `provider_not_configured` | `VPNRESELLERS_API_TOKEN` missing | Set locally; order stays paid, awaiting provisioning |
| `503 Webhook not configured` (ads) | `STRIPE_WEBHOOK_SECRET` empty | Set locally (example-only in `.dev.vars.example`) |

---

## 7. Manual renewal verification (test mode)

Renewal is a separate one-time payment that extends the existing entitlement.

**Prerequisites:** same as section 3, plus an order already in `active` status with
`expire_at` within 30 days.

**Steps:**
1. Sign in as the customer who owns the order (magic link, if configured; otherwise
   use the test session helper).
2. Open `/account/orders/:id`. The "Renew now" button appears only when
   `days_remaining <= 30`.
3. Submit the renewal form. Expect `303` redirect to a Stripe Checkout URL with
   `metadata.renewal=1`.
4. Complete payment with a Stripe test card.
5. Stripe sends `checkout.session.completed` with `metadata.renewal=1` to
   `/api/vpn/webhook`. Verify:
   - amount and currency match the stored order
   - `expire_at` extended by `interval_months` from the **current** expiry
   - `renewal_extended` event recorded
   - order stays `active` (no new provisioning, no new provider account)
6. Replay the same event ID. Expect `200` with `duplicate: true`; `expire_at`
   must not change a second time.
7. Abandon a renewal checkout (close the browser). Expect no webhook, no DB write,
   current access unchanged.

**Never:** renewal must never create a Stripe Subscription or recurring Price.
Verify `mode=payment` in the checkout session params (no `subscription` fields).

---

## 8. Admin test configuration (local only)

The two admin VPN route tests (`returns sanitized provisioning state to an admin`,
`allows an admin to retry provisioning, but only with CSRF`) require a non-empty
`ADMIN_PASSWORD_HASH` in `.dev.vars`.

Generate locally (never commit the value):
```powershell
node worker/dev-tools/hash-password.mjs test-admin-password-1234
# paste the printed hash into .dev.vars as ADMIN_PASSWORD_HASH=<hash>
```
This is a local test configuration step. It does not weaken authentication.
