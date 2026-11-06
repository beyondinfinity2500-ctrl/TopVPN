-- 0003_vpn_orders.sql
-- VPN subscription sales domain. Separate from the advertising tables on
-- purpose: no query or webhook handler may confuse the two order types.
-- Apply locally with:
--   npx wrangler d1 migrations apply topvpn-ads --local --config wrangler.ads.jsonc
-- Do NOT apply remotely in this phase.

CREATE TABLE IF NOT EXISTS vpn_orders (
  id                       TEXT PRIMARY KEY,            -- ORD-VPN-<uuid>
  customer_email           TEXT NOT NULL,
  customer_name            TEXT,
  plan_id                  TEXT NOT NULL,               -- monthly|annual|two-year
  interval_months          INTEGER NOT NULL,
  amount_cents             INTEGER NOT NULL,            -- server-calculated only
  currency                 TEXT NOT NULL DEFAULT 'USD',
  -- Four independent state dimensions, never collapsed into one column.
  order_status             TEXT NOT NULL DEFAULT 'pending_payment',
  payment_status           TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid|paid|refunded
  provisioning_status      TEXT NOT NULL DEFAULT 'none',     -- none|claimed|provisioning|succeeded|failed|reconciliation
  subscription_status      TEXT NOT NULL DEFAULT 'none',     -- none|active|expired|cancelled
  provider_account_id      TEXT,
  provider_username        TEXT,
  expire_at                TEXT,                        -- YYYY-MM-DD (provider format)
  failure_reason           TEXT,
  stripe_session_id        TEXT,
  stripe_payment_intent    TEXT,
  stripe_checkout_url      TEXT,
  checkout_idempotency_key TEXT,
  version                  INTEGER NOT NULL DEFAULT 0,  -- optimistic concurrency
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  paid_at                  TEXT,
  CHECK (amount_cents > 0),
  CHECK (currency = 'USD'),
  CHECK (plan_id IN ('monthly','annual','two-year')),
  CHECK (order_status IN ('pending_payment','paid','provisioning','active','provisioning_failed','reconciliation_required','expired','cancelled','refunded')),
  CHECK (payment_status IN ('unpaid','paid','refunded')),
  CHECK (provisioning_status IN ('none','claimed','provisioning','succeeded','failed','reconciliation')),
  CHECK (subscription_status IN ('none','active','expired','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_vpn_orders_status   ON vpn_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_vpn_orders_email    ON vpn_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_vpn_orders_session_lookup ON vpn_orders(stripe_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_orders_provider_account
  ON vpn_orders(provider_account_id) WHERE provider_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_orders_checkout_key
  ON vpn_orders(checkout_idempotency_key) WHERE checkout_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_orders_session
  ON vpn_orders(stripe_session_id) WHERE stripe_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vpn_orders_payment_intent ON vpn_orders(stripe_payment_intent);

-- Verified payment events. The primary key is Stripe's event id, so a replayed
-- webhook can never be processed twice.
CREATE TABLE IF NOT EXISTS vpn_payment_events (
  event_id      TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  amount_cents  INTEGER,
  currency      TEXT,
  received_at   TEXT NOT NULL,
  processed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_vpn_payment_events_order ON vpn_payment_events(order_id);

-- Atomic provisioning gate: one row per order, written before the provider call.
CREATE TABLE IF NOT EXISTS vpn_provisioning_claims (
  claim_key   TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- Provider account mapping. No VPN credentials are stored here yet; credential
-- delivery is a later work package (see docs/PLATFORM_IMPLEMENTATION.md).
CREATE TABLE IF NOT EXISTS vpn_accounts (
  order_id             TEXT PRIMARY KEY,
  provider_account_id  TEXT NOT NULL UNIQUE,
  username             TEXT NOT NULL UNIQUE,
  expire_at            TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Append-only audit trail (no secrets, no provider payloads).
CREATE TABLE IF NOT EXISTS vpn_order_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vpn_order_events_order ON vpn_order_events(order_id, id);
