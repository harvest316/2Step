-- 2Step Database Schema
-- Status flow: found → video_prompted → video_created → outreach_sent
--   → followup_1 → followup_2 → followup_3 → interested/closed/not_interested

CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    owner_first_name TEXT,
    google_maps_url TEXT,
    website_url TEXT,
    phone TEXT,
    email TEXT,
    instagram_handle TEXT,
    facebook_page_url TEXT,
    city TEXT,
    state TEXT,
    country_code TEXT DEFAULT 'AU',
    google_rating REAL,
    review_count INTEGER,
    best_review_text TEXT,
    best_review_author TEXT,
    niche TEXT,
    status TEXT DEFAULT 'found',
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    video_tool TEXT NOT NULL CHECK(video_tool IN ('invideo','holo','creatomate','fliki','shotstack')),
    video_url TEXT,
    thumbnail_url TEXT,   -- R2 URL of the poster image (Creatomate snapshot + baked-in play button)
    -- Migration for existing DB: ALTER TABLE videos ADD COLUMN thumbnail_url TEXT;
    prompt_text TEXT,
    status TEXT DEFAULT 'prompted' CHECK(status IN ('prompted','rendering','completed','failed','delivered')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outreaches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    video_id INTEGER REFERENCES videos(id),
    channel TEXT NOT NULL CHECK(channel IN ('email','instagram_dm','facebook_dm','form')),
    contact_uri TEXT NOT NULL,
    message_body TEXT,
    delivery_status TEXT DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','delivered','failed','replied','bounced')),
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    outreach_id INTEGER REFERENCES outreaches(id),
    followup_number INTEGER NOT NULL CHECK(followup_number BETWEEN 1 AND 3),
    channel TEXT NOT NULL,
    message_body TEXT,
    scheduled_at DATETIME NOT NULL,
    sent_at DATETIME,
    delivery_status TEXT DEFAULT 'scheduled',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id),
    channel TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    message_body TEXT,
    intent TEXT CHECK(intent IN ('interested','not_interested','question','opt_out','unknown')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_niche ON prospects(niche);
CREATE INDEX IF NOT EXISTS idx_prospects_country ON prospects(country_code);
CREATE INDEX IF NOT EXISTS idx_videos_prospect ON videos(prospect_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_outreaches_prospect ON outreaches(prospect_id);
CREATE INDEX IF NOT EXISTS idx_outreaches_status ON outreaches(delivery_status);
CREATE INDEX IF NOT EXISTS idx_followups_scheduled ON followups(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_conversations_prospect ON conversations(prospect_id);
