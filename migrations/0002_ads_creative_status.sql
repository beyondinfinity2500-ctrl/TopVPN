-- 0002_ads_creative_status.sql
-- Optimization state for image creatives: only successfully optimized output is
-- stored in R2, so the order needs its own creative status separate from the
-- (unchanged) payment and approval workflows.
--
-- creative_status:   pending (default) | ready (optimized + stored) | failed
--                     (service error/quota; admin can retry via replace)
-- creative_width/height: dimensions of the stored WebP output.
-- creative_optimization_error: admin-visible reason (never raw stack traces).
--
-- Apply with: npx wrangler d1 migrations apply topvpn-ads --remote
--             npx wrangler d1 migrations apply topvpn-ads --local

ALTER TABLE ads_orders ADD COLUMN creative_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE ads_orders ADD COLUMN creative_width INTEGER;
ALTER TABLE ads_orders ADD COLUMN creative_height INTEGER;
ALTER TABLE ads_orders ADD COLUMN creative_optimization_error TEXT;
