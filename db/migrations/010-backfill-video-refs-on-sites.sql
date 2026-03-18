-- Migration 010: Backfill video_id, video_url, video_hash on sites table
--
-- All 30 video_created sites have NULL video_id, video_url, video_hash because
-- they were created by the old standalone renderer (src/video/creatomate.js)
-- which only updated the videos table but not the sites table columns that
-- were added later in migration 002.
--
-- This backfill pulls the latest completed video per site and populates the
-- sites table columns that the outreach/proposals stages depend on.
--
-- NOTE: video_hash requires base62 encoding which SQLite cannot do natively.
-- Run the companion script to compute proper base62 hashes:
--   node db/migrations/010-backfill-video-refs.js

-- Step 1: Backfill video_id from the latest completed video per site
UPDATE sites
SET video_id = (
  SELECT v.id FROM videos v
  WHERE v.site_id = sites.id AND v.status = 'completed'
  ORDER BY v.created_at DESC LIMIT 1
)
WHERE status = 'video_created' AND video_id IS NULL;

-- Step 2: Backfill video_url from the same video
UPDATE sites
SET video_url = (
  SELECT v.video_url FROM videos v
  WHERE v.site_id = sites.id AND v.status = 'completed'
  ORDER BY v.created_at DESC LIMIT 1
)
WHERE status = 'video_created' AND video_url IS NULL;
