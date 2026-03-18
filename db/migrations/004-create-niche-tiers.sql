-- Migration 004: Create niche_tiers table and seed data
-- Maps each niche to a pricing tier (budget / standard / premium).
-- The pricing table with actual prices lives in mmo-platform/db/messages.db.
-- Lookup: SELECT p.* FROM msgs.pricing p JOIN niche_tiers n ON n.tier = p.niche_tier
--         WHERE p.project='2step' AND p.country_code=? AND n.niche=? AND p.superseded_at IS NULL

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS niche_tiers (
    niche TEXT PRIMARY KEY,
    tier  TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'premium'))
);

INSERT OR IGNORE INTO niche_tiers (niche, tier) VALUES
    ('roofing',                 'standard'),
    ('med spa',                 'standard'),
    ('dentist',                 'standard'),
    ('real estate',             'standard'),
    ('hvac',                    'standard'),
    ('pest control',            'standard'),
    ('personal injury lawyer',  'premium'),
    ('pool installer',          'premium'),
    ('chiropractor',            'budget'),
    ('plumber',                 'budget'),
    ('dog trainer',             'budget');

COMMIT;
