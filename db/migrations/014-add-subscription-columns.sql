-- Add subscription tracking columns to sites table
ALTER TABLE sites ADD COLUMN paypal_subscription_id TEXT;
ALTER TABLE sites ADD COLUMN subscription_status TEXT CHECK(subscription_status IN ('active','paused','cancelled','expired','payment_failed'));
ALTER TABLE sites ADD COLUMN subscription_tier TEXT CHECK(subscription_tier IN ('monthly_4','monthly_8','monthly_12'));
ALTER TABLE sites ADD COLUMN next_billing_date TEXT;
ALTER TABLE sites ADD COLUMN cancellation_date TEXT;

-- Subscription events audit trail
CREATE TABLE IF NOT EXISTS subscription_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    site_id INTEGER REFERENCES sites(id),
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sub_events_subscription ON subscription_events(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_type ON subscription_events(event_type);
