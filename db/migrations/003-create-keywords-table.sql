-- Migration 003: Create keywords table
-- Schema mirrors 333Method's keywords table (source of truth) with the addition
-- of a `location` column for 2Step's niche+location search pairs.
--
-- 333Method keywords are flat "keyword + country_code" (e.g. keyword="pest control sydney").
-- 2Step keywords are niche+location pairs: niche="pest control", location="Sydney".
-- The `keyword` column stores the full search string ("pest control Sydney").

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,                -- full search string: "pest control Sydney"
    location TEXT,                        -- location component: "Sydney" (2Step-specific)
    priority INTEGER DEFAULT 5 CHECK(priority >= 1 AND priority <= 10),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
    search_count INTEGER DEFAULT 0,       -- how many times this keyword was searched
    sites_found_count INTEGER DEFAULT 0,  -- how many sites were found via this keyword
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

COMMIT;
