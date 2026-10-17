-- 0001_ads_init.sql
-- Advertising orders, webhook idempotency log, admin sessions, rate limits.
-- Apply with: npx wrangler d1 migrations apply topvpn-ads --remote
--             npx wrangler d1 migrations apply topvpn-ads --local

CREATE TABLE IF NOT EXISTS ads_orders (
  id                        TEXT PRIMARY KEY,           -- e.g. ORD-<uuid>
  customer_name             TEXT NOT NULL,
  customer_email            TEXT NOT NULL,
  customer_website          TEXT NOT NULL,
  placement                 TEXT NOT NULL,              -- header|incontent|footer|fullsite
  duration_months           INTEGER NOT NULL,           -- 1|3|6|12
  creative_format           TEXT NOT NULL,              -- text|image
  ad_copy                   TEXT,                       -- text creative
  destination_url           TEXT,                       -- text ads only
  creative_r2_key           TEXT,                       -- image ads only
  amount_cents              INTEGER NOT NULL,           -- server-calculated
  currency                  TEXT NOT NULL DEFAULT 'USD',
  payment_status            TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|failed|expired|cancelled
  stripe_checkout_session_id TEXT,
  stripe_payment_reference  TEXT,
  approval_status           TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  campaign_status           TEXT NOT NULL DEFAULT 'pending',  -- pending|scheduled|active|completed|cancelled
  campaign_start            TEXT,                       -- ISO timestamps, set on scheduling
  campaign_end              TEXT,
  admin_notes               TEXT,
  customer_email_status     TEXT,                       -- sent|failed:*|not_configured
  admin_email_status        TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  CHECK (payment_status IN ('pending','paid','failed','expired','cancelled')),
  CHECK (approval_status IN ('pending','approved','rejected')),
  CHECK (campaign_status IN ('pending','scheduled','active','completed','cancelled')),
  CHECK (creative_format IN ('text','image')),
  CHECK (amount_cents > 0)
);

CREATE INDEX IF NOT EXISTS idx_ads_orders_created ON ads_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_orders_payment ON ads_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_ads_orders_email   ON ads_orders(customer_email);

-- Stripe webhook idempotency: each event id is processed at most once.
CREATE TABLE IF NOT EXISTS ads_webhook_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT,
  event_type   TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

-- Admin sessions (token is the cookie value; csrf_token is the double-submit token).
CREATE TABLE IF NOT EXISTS ads_admin_sessions (
  token       TEXT PRIMARY KEY,
  csrf_token  TEXT NOT NULL,
  ip          TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ads_admin_sessions_expires ON ads_admin_sessions(expires_at);

-- Fixed-window rate limiting keyed by action + ip.
CREATE TABLE IF NOT EXISTS ads_rate_limits (
  key          TEXT NOT NULL,          -- e.g. order:<ip> | login:<ip>
  bucket       INTEGER NOT NULL,       -- window start (unix seconds)
  count        INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
