-- Migration 011: Add "house cleaning service" to niche_tiers
--
-- 14 prospects (38% of DB) have niche='house cleaning service' but no matching
-- niche_tiers row, so lookupPricing() in proposals.js returns null and they
-- get no pricing_id. This blocks the entire outreach flow for those sites.
--
-- Tier: "standard" — mid-range service business, comparable to pest control / HVAC.

INSERT OR IGNORE INTO niche_tiers (niche, tier) VALUES ('house cleaning service', 'standard');
