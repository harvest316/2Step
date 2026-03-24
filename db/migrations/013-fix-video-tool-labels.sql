-- Migration 013: Fix video_tool labels for local FFmpeg renders
--
-- The stages/video.js pipeline and deprecated creatomate.js both use local
-- FFmpeg for rendering, but labelled videos as 'shotstack' and 'creatomate'
-- respectively. This migration:
--   1. Recreates table with 'ffmpeg' in the CHECK constraint
--   2. Copies data with corrected labels
--
-- Since SQLite CHECK fires on UPDATE, we must recreate the table first.

-- Step 1: Create new table with updated CHECK constraint
CREATE TABLE videos_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    video_tool TEXT NOT NULL CHECK(video_tool IN ('invideo','holo','creatomate','fliki','shotstack','ffmpeg')),
    video_url TEXT,
    prompt_text TEXT,
    status TEXT DEFAULT 'prompted' CHECK(status IN ('prompted','rendering','completed','failed','delivered')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    thumbnail_url TEXT,
    style_variant TEXT,
    render_id TEXT,
    voiceover_url TEXT,
    music_track TEXT,
    duration_seconds INTEGER,
    cost_usd REAL
);

-- Step 2: Copy data with corrected labels
INSERT INTO videos_new (id, site_id, video_tool, video_url, prompt_text, status, created_at, thumbnail_url, style_variant, render_id, voiceover_url, music_track, duration_seconds, cost_usd)
SELECT id, site_id,
  CASE WHEN video_tool IN ('creatomate', 'shotstack') THEN 'ffmpeg' ELSE video_tool END,
  video_url, prompt_text, status, created_at, thumbnail_url, style_variant, render_id, voiceover_url, music_track, duration_seconds, cost_usd
FROM videos;

-- Step 3: Swap tables
DROP TABLE videos;
ALTER TABLE videos_new RENAME TO videos;

-- Step 4: Recreate indexes
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_videos_site ON videos(site_id);
