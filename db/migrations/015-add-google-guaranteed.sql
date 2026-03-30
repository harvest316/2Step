ALTER TABLE sites ADD COLUMN is_google_guaranteed INTEGER DEFAULT 0;
CREATE INDEX idx_sites_google_guaranteed ON sites(is_google_guaranteed) WHERE is_google_guaranteed = 1;
