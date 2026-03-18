-- Migration 002: Add pipeline columns to sites table
-- Only adds columns that do not already exist in the original prospects schema.
--
-- Columns already present (from original prospects/sites schema):
--   id, business_name, owner_first_name, google_maps_url, website_url, phone, email,
--   instagram_handle, facebook_page_url, city, state, country_code, google_rating,
--   review_count, best_review_text, best_review_author, niche, status, error_message,
--   created_at, updated_at
--
-- New status values added by this pipeline (enforced in schema.sql, not here):
--   found, reviews_downloaded, enriched, video_created, proposals_drafted,
--   outreach_sent, replied, interested, closed, not_interested, ignored, failing

BEGIN IMMEDIATE;

ALTER TABLE sites ADD COLUMN domain TEXT;
ALTER TABLE sites ADD COLUMN google_place_id TEXT;
ALTER TABLE sites ADD COLUMN selected_review_json TEXT;   -- qualifying review used for the free video
ALTER TABLE sites ADD COLUMN problem_category TEXT;       -- clip pool category (e.g. "termite treatment")
ALTER TABLE sites ADD COLUMN all_reviews_json TEXT;       -- post-payment: ALL 4-5* reviews
ALTER TABLE sites ADD COLUMN video_hash TEXT;             -- base62 hash for /v/{hash} URL
ALTER TABLE sites ADD COLUMN video_viewed_at DATETIME;    -- when prospect viewed their video page
ALTER TABLE sites ADD COLUMN contacts_json TEXT;          -- {emails:[], phones:[], socials:{}, forms:[]}
ALTER TABLE sites ADD COLUMN screenshot_path TEXT;
ALTER TABLE sites ADD COLUMN video_url TEXT;              -- final hosted video URL
ALTER TABLE sites ADD COLUMN video_id INTEGER;            -- FK to latest completed video
ALTER TABLE sites ADD COLUMN keyword TEXT;                -- keyword that found this site
ALTER TABLE sites ADD COLUMN conversation_status TEXT;
ALTER TABLE sites ADD COLUMN resulted_in_sale INTEGER DEFAULT 0;
ALTER TABLE sites ADD COLUMN sale_amount REAL DEFAULT 0;
ALTER TABLE sites ADD COLUMN last_outreach_at DATETIME;
ALTER TABLE sites ADD COLUMN followup1_sent_at DATETIME;
ALTER TABLE sites ADD COLUMN followup2_sent_at DATETIME;
ALTER TABLE sites ADD COLUMN retry_count INTEGER DEFAULT 0;

-- Add new indexes for pipeline query patterns
CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
CREATE INDEX IF NOT EXISTS idx_sites_google_place_id ON sites(google_place_id);
CREATE INDEX IF NOT EXISTS idx_sites_conversation_status ON sites(conversation_status);
CREATE INDEX IF NOT EXISTS idx_sites_last_outreach ON sites(last_outreach_at);
CREATE INDEX IF NOT EXISTS idx_sites_video_hash ON sites(video_hash);

COMMIT;
