-- Migration 011: Add UNIQUE index on sites.google_place_id
-- Prevents duplicate prospect rows for the same Google Places listing.
-- Partial index (WHERE google_place_id IS NOT NULL) allows multiple rows
-- with NULL google_place_id (manually imported prospects without a Maps ID).

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_google_place_id_unique
  ON sites(google_place_id) WHERE google_place_id IS NOT NULL;
