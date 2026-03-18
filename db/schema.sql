-- 2Step Database Schema
-- This file reflects the final schema AFTER all migrations (001-008) have been applied.
-- It is the reference for greenfield deployments only — do not use it to reset an
-- existing production database. Migrations in db/migrations/ are the source of truth.
--
-- Status flow:
--   found -> reviews_downloaded -> enriched -> video_created -> proposals_drafted
--   -> outreach_sent -> replied -> interested/closed/not_interested
--   ignored / failing (terminal states, can retry)

-- =============================================================================
-- sites: one row per prospect business
-- (renamed from prospects in migration 001)
-- =============================================================================
CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Discovery
    business_name TEXT NOT NULL,
    domain TEXT,
    google_place_id TEXT,
    keyword TEXT,                          -- keyword that found this site
    google_maps_url TEXT,

    -- Contact details (from original import)
    owner_first_name TEXT,
    website_url TEXT,
    phone TEXT,
    email TEXT,
    instagram_handle TEXT,
    facebook_page_url TEXT,
    city TEXT,
    state TEXT,
    country_code TEXT DEFAULT 'AU',

    -- Google listing data
    google_rating REAL,
    review_count INTEGER,
    best_review_text TEXT,                 -- legacy: original best review text
    best_review_author TEXT,               -- legacy: original best review author

    -- Pipeline data
    niche TEXT,
    selected_review_json TEXT,             -- qualifying review used for the free video
    problem_category TEXT,                 -- clip pool category (e.g. "termite treatment")
    all_reviews_json TEXT,                 -- post-payment: ALL 4-5* reviews
    contacts_json TEXT,                    -- {emails:[], phones:[], socials:{}, forms:[]}

    -- Video
    video_hash TEXT,                       -- base62 hash for /v/{hash} URL
    video_url TEXT,                        -- final hosted video URL
    video_id INTEGER,                      -- FK to latest completed video in videos table
    video_viewed_at DATETIME,              -- when prospect viewed their video page
    screenshot_path TEXT,

    -- Pipeline status
    status TEXT DEFAULT 'found',
    error_message TEXT,

    -- Outreach tracking
    conversation_status TEXT,
    last_outreach_at DATETIME,
    followup1_sent_at DATETIME,
    followup2_sent_at DATETIME,
    retry_count INTEGER DEFAULT 0,

    -- Conversion
    resulted_in_sale INTEGER DEFAULT 0,
    sale_amount REAL DEFAULT 0,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_niche ON sites(niche);
CREATE INDEX IF NOT EXISTS idx_sites_country ON sites(country_code);
CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
CREATE INDEX IF NOT EXISTS idx_sites_google_place_id ON sites(google_place_id);
CREATE INDEX IF NOT EXISTS idx_sites_conversation_status ON sites(conversation_status);
CREATE INDEX IF NOT EXISTS idx_sites_last_outreach ON sites(last_outreach_at);
CREATE INDEX IF NOT EXISTS idx_sites_video_hash ON sites(video_hash);

-- =============================================================================
-- videos: one row per rendered video attempt
-- FK renamed from prospect_id to site_id in line with sites table rename.
-- =============================================================================
CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    video_tool TEXT NOT NULL CHECK(video_tool IN ('invideo', 'holo', 'creatomate', 'fliki', 'shotstack', 'ffmpeg')),
    video_url TEXT,
    thumbnail_url TEXT,                    -- R2 URL of poster image (snapshot + play button)
    prompt_text TEXT,
    render_id TEXT,                        -- external render job ID (Creatomate/Shotstack)
    voiceover_url TEXT,                    -- ElevenLabs output URL
    music_track TEXT,                      -- music file used in render
    duration_seconds INTEGER,
    cost_usd REAL,                         -- API cost for this render (0 for local ffmpeg)
    status TEXT DEFAULT 'prompted' CHECK(status IN ('prompted', 'rendering', 'completed', 'failed', 'delivered')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_videos_site ON videos(site_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);

-- =============================================================================
-- keywords: niche + location search pairs for Outscraper Maps discovery
-- Mirrors 333Method's keywords table schema, plus a `location` column.
-- =============================================================================
CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,                 -- full search string: "pest control Sydney"
    location TEXT,                         -- location component: "Sydney"
    priority INTEGER DEFAULT 5 CHECK(priority >= 1 AND priority <= 10),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
    search_count INTEGER DEFAULT 0,
    sites_found_count INTEGER DEFAULT 0,
    search_volume INTEGER DEFAULT 0,
    country_code TEXT NOT NULL,
    last_searched_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(keyword, country_code)
);

CREATE INDEX IF NOT EXISTS idx_keywords_country ON keywords(country_code);
CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status);
CREATE INDEX IF NOT EXISTS idx_keywords_priority ON keywords(priority DESC);
CREATE INDEX IF NOT EXISTS idx_keywords_search_count ON keywords(search_count);
CREATE INDEX IF NOT EXISTS idx_keywords_last_searched ON keywords(last_searched_at);

-- =============================================================================
-- niche_tiers: maps each niche to a pricing tier
-- Actual prices live in mmo-platform/db/messages.db (msgs.pricing table).
-- Lookup: SELECT p.* FROM msgs.pricing p JOIN niche_tiers n ON n.tier = p.niche_tier
--         WHERE p.project='2step' AND p.country_code=? AND n.niche=? AND p.superseded_at IS NULL
-- =============================================================================
CREATE TABLE IF NOT EXISTS niche_tiers (
    niche TEXT PRIMARY KEY,
    tier  TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'premium'))
);

INSERT OR IGNORE INTO niche_tiers (niche, tier) VALUES
    ('roofing',                  'standard'),
    ('med spa',                  'standard'),
    ('dentist',                  'standard'),
    ('real estate',              'standard'),
    ('hvac',                     'standard'),
    ('pest control',             'standard'),
    ('house cleaning service',   'standard'),
    ('personal injury lawyer',   'premium'),
    ('pool installer',           'premium'),
    ('chiropractor',             'budget'),
    ('plumber',                  'budget'),
    ('dog trainer',              'budget');

-- =============================================================================
-- Pricing reference (lives in msgs.pricing — documented here for reference)
-- =============================================================================
-- The pricing table is in mmo-platform/db/messages.db, not in this DB.
-- Access via: SELECT * FROM msgs.pricing WHERE project='2step' AND superseded_at IS NULL
--
-- Schema (msgs.pricing):
--   id, project, country_code, niche_tier, setup_local, monthly_4, monthly_8,
--   monthly_12, report_price, currency, effective_from, superseded_at
--
-- Seed rows for 2step are inserted by mmo-platform/scripts/init-messages-db.js.
-- Never INSERT or UPDATE msgs.pricing directly — use append-only versioning:
--   set superseded_at = date('now') on old row, INSERT new row with effective_from = date('now').
