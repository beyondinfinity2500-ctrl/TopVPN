-- 0007_payment_mode.sql
-- Adds payment_mode column to vpn_orders to track whether an order was created
-- in sandbox (test) or live (production) mode. This is an immutable, trusted
-- server-side record that provisioning and credential delivery must verify.
--
-- Default is 'sandbox' (fail-closed): orders created without an explicit mode
-- are treated as sandbox and can never trigger real VPNResellers provisioning.
--
-- Apply locally with:
--   npx wrangler d1 migrations apply topvpn-ads --local --config wrangler.ads.jsonc
-- Do NOT apply remotely without explicit owner approval.

ALTER TABLE vpn_orders ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'sandbox';

CREATE INDEX IF NOT EXISTS idx_vpn_orders_payment_mode ON vpn_orders(payment_mode);