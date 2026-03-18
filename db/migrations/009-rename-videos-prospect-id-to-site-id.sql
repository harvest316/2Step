-- Migration 009: Rename videos.prospect_id to videos.site_id
-- Aligns the FK column name with the sites table rename (migration 001).
-- Also adds new columns for the full render pipeline.
--
-- SQLite ALTER TABLE RENAME COLUMN requires SQLite 3.25.0+ (we have 3.45+).

BEGIN IMMEDIATE;

ALTER TABLE videos RENAME COLUMN prospect_id TO site_id;

-- Add pipeline columns that are missing from the original videos schema
ALTER TABLE videos ADD COLUMN render_id TEXT;         -- external render job ID
ALTER TABLE videos ADD COLUMN voiceover_url TEXT;      -- ElevenLabs output URL
ALTER TABLE videos ADD COLUMN music_track TEXT;        -- music file used in render
ALTER TABLE videos ADD COLUMN duration_seconds INTEGER;
ALTER TABLE videos ADD COLUMN cost_usd REAL;           -- API cost (0 for local ffmpeg)

-- Rename existing index to reflect new column name
DROP INDEX IF EXISTS idx_videos_prospect;
CREATE INDEX IF NOT EXISTS idx_videos_site ON videos(site_id);

COMMIT;
