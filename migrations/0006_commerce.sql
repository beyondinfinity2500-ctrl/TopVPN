-- 0006_commerce.sql
-- Commerce extensions: coupons (incl. one-time first-purchase discount),
-- customer blocking, support tickets, admin audit log, PayPal columns.
-- LOCAL ONLY in this phase. Apply with:
--   npx wrangler d1 migrations apply topvpn-ads --local --config wrangler.ads.jsonc

-- Payment provider + coupon breakdown on VPN orders (one-time payments only;
-- no recurring columns on purpose).
ALTER TABLE vpn_orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE vpn_orders ADD COLUMN coupon_id TEXT;
ALTER TABLE vpn_orders ADD COLUMN original_amount_cents INTEGER;
ALTER TABLE vpn_orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vpn_orders ADD COLUMN paypal_order_id TEXT;
ALTER TABLE vpn_orders ADD COLUMN paypal_capture_id TEXT;

-- Customer blocking (admin support action).
ALTER TABLE vpn_customers ADD COLUMN blocked_at TEXT;
ALTER TABLE vpn_customers ADD COLUMN blocked_reason TEXT;

-- Coupons. `discount_type` is 'fixed' (cents off) or 'percent'.
-- The $9 -> $3 first-month offer is seeded as FIRST-MONTH (fixed 600 off
-- monthly, first purchase only). Commercial prices themselves never change.
CREATE TABLE IF NOT EXISTS vpn_coupons (
  id                    TEXT PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE,
  description           TEXT,
  discount_type         TEXT NOT NULL CHECK (discount_type IN ('fixed','percent')),
  discount_value        INTEGER NOT NULL CHECK (discount_value > 0),
  applies_plan_id       TEXT,                        -- NULL = any plan
  first_purchase_only   INTEGER NOT NULL DEFAULT 0,
  starts_at             TEXT,
  expires_at            TEXT,
  max_redemptions       INTEGER,                     -- NULL = unlimited
  per_customer_limit    INTEGER NOT NULL DEFAULT 1,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  CHECK (applies_plan_id IS NULL OR applies_plan_id IN ('monthly','annual','two-year'))
);

-- One row per redemption. The two UNIQUE indexes make double redemption
-- impossible even under concurrent checkout requests.
CREATE TABLE IF NOT EXISTS vpn_coupon_redemptions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id          TEXT NOT NULL,
  customer_email     TEXT NOT NULL,                 -- lower(trim(email))
  order_id           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (coupon_id, customer_email)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_coupon_redemptions_order
  ON vpn_coupon_redemptions(order_id);
CREATE INDEX IF NOT EXISTS idx_vpn_coupon_redemptions_coupon
  ON vpn_coupon_redemptions(coupon_id);

-- Seeded launch offer. Idempotent; changing commercial prices is out of scope.
INSERT OR IGNORE INTO vpn_coupons
  (id, code, description, discount_type, discount_value, applies_plan_id,
   first_purchase_only, per_customer_limit, active, created_at)
VALUES
  ('cpn-first-month', 'FIRST-MONTH',
   'First month of the Monthly plan for $3 instead of $9. One-time, first purchase only.',
   'fixed', 600, 'monthly', 1, 1, 1, '2026-01-01T00:00:00.000Z');

-- Support tickets (customer portal + admin + AI chatbot handoff).
CREATE TABLE IF NOT EXISTS support_tickets (
  id               TEXT PRIMARY KEY,               -- TCK-<uuid>
  customer_id      TEXT,                           -- NULL for guest tickets
  customer_email   TEXT NOT NULL,
  subject          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','pending','closed')),
  priority         TEXT NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low','normal','high')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_email ON support_tickets(customer_email);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id    TEXT NOT NULL,
  author       TEXT NOT NULL CHECK (author IN ('customer','admin','ai')),
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
  ON support_ticket_messages(ticket_id, id);

-- Append-only admin audit log for sensitive actions. No secrets, no payloads.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,                       -- 'admin' (single-admin system)
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at);
