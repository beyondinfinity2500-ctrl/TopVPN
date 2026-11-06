-- 0005_vpn_provisioning_attempts.sql
-- Durable, complete provisioning attempt counter (events alone miss attempts
-- that fail before the transition). Applied to disposable databases only.
ALTER TABLE vpn_orders ADD COLUMN provisioning_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_vpn_orders_recovery
  ON vpn_orders(order_status, updated_at);
