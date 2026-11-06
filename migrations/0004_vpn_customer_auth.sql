-- 0004_vpn_customer_auth.sql
-- Customer identity (magic-link) and order ownership. Entirely separate from
-- the advertising admin sessions in ads_admin_sessions.
-- Apply locally only, to a DISPOSABLE database:
--   npx wrangler d1 migrations apply topvpn-ads --local \
--     --persist-to <temp-dir> --config wrangler.ads.jsonc
-- Do NOT apply this to the shared local or remote database in this phase.

CREATE TABLE IF NOT EXISTS vpn_customers (
  id          TEXT PRIMARY KEY,           -- CUS-<uuid>
  email_norm  TEXT NOT NULL UNIQUE,       -- lower(trim(email))
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Only the SHA-256 hash of a magic-link token is stored.
CREATE TABLE IF NOT EXISTS vpn_customer_tokens (
  token_hash   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vpn_customer_tokens_customer
  ON vpn_customer_tokens(customer_id);

CREATE INDEX IF NOT EXISTS idx_vpn_customer_tokens_expires
  ON vpn_customer_tokens(expires_at);

-- Customer sessions are separate from ads_admin_sessions and use a different
-- cookie, so an admin session can never authenticate a customer.
CREATE TABLE IF NOT EXISTS vpn_customer_sessions (
  token_hash   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vpn_customer_sessions_customer
  ON vpn_customer_sessions(customer_id);

CREATE INDEX IF NOT EXISTS idx_vpn_customer_sessions_expires
  ON vpn_customer_sessions(expires_at);

-- Links an order to exactly one verified customer (by verified email at login).
CREATE TABLE IF NOT EXISTS vpn_customer_orders (
  order_id     TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  linked_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vpn_customer_orders_customer
  ON vpn_customer_orders(customer_id, linked_at);

-- Supports the read-time ownership linking without a full table scan.
CREATE INDEX IF NOT EXISTS idx_vpn_orders_email_norm
  ON vpn_orders(lower(trim(customer_email)));
