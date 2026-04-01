-- Migration 016: Create countries table
-- Centralises country-specific config including state/territory abbreviations
-- used to strip regional suffixes from Google Maps business names before voiceover.
--
-- state_abbreviations: JSON array of ISO codes (or Google Maps conventions) for
-- administrative divisions that commonly appear appended to business names,
-- e.g. "Acme Cleaning PTY LTD - NSW" or "Fast Plumbing (QLD)".
-- Empty array [] for countries where this doesn't occur.

CREATE TABLE IF NOT EXISTS countries (
  country_code        TEXT PRIMARY KEY,   -- ISO 3166-1 alpha-2 (e.g. 'AU', 'US', 'UK')
  country_name        TEXT NOT NULL,
  language_code       TEXT NOT NULL,      -- ISO 639-1
  timezone            TEXT NOT NULL,      -- IANA timezone
  currency_code       TEXT NOT NULL,      -- ISO 4217
  currency_symbol     TEXT NOT NULL,
  requires_gdpr_check INTEGER DEFAULT 0,  -- 1 for EU/EEA
  state_abbreviations TEXT DEFAULT '[]',  -- JSON array
  is_active           INTEGER DEFAULT 1,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_countries_active ON countries(is_active);

INSERT OR IGNORE INTO countries
  (country_code, country_name, language_code, timezone, currency_code, currency_symbol, requires_gdpr_check, state_abbreviations)
VALUES
  -- Premium+ Tier
  ('SG', 'Singapore',      'en', 'Asia/Singapore',    'SGD', 'S$', 0, '[]'),
  ('IE', 'Ireland',        'en', 'Europe/Dublin',      'EUR', '€',  1, '[]'),

  -- Premium Tier
  ('US', 'United States',  'en', 'America/New_York',  'USD', '$',  0,
    '["AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"]'),
  ('NO', 'Norway',         'no', 'Europe/Oslo',        'NOK', 'kr', 1, '[]'),
  ('CH', 'Switzerland',    'de', 'Europe/Zurich',      'CHF', 'CHF',0, '[]'),
  ('NL', 'Netherlands',    'nl', 'Europe/Amsterdam',   'EUR', '€',  1, '[]'),
  ('DK', 'Denmark',        'da', 'Europe/Copenhagen',  'DKK', 'kr', 1, '[]'),

  -- Standard Tier
  ('AT', 'Austria',        'de', 'Europe/Vienna',      'EUR', '€',  1, '[]'),
  ('SE', 'Sweden',         'sv', 'Europe/Stockholm',   'SEK', 'kr', 1, '[]'),
  ('BE', 'Belgium',        'nl', 'Europe/Brussels',    'EUR', '€',  1, '[]'),
  ('AU', 'Australia',      'en', 'Australia/Sydney',   'AUD', '$',  0,
    '["ACT","NSW","NT","QLD","SA","TAS","VIC","WA"]'),
  ('DE', 'Germany',        'de', 'Europe/Berlin',      'EUR', '€',  1, '[]'),

  -- Standard Tier (lower)
  ('CA', 'Canada',         'en', 'America/Toronto',    'CAD', '$',  0,
    '["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"]'),
  ('KR', 'South Korea',    'ko', 'Asia/Seoul',         'KRW', '₩',  0, '[]'),
  ('FR', 'France',         'fr', 'Europe/Paris',       'EUR', '€',  1, '[]'),
  ('UK', 'United Kingdom', 'en', 'Europe/London',      'GBP', '£',  1, '[]'),
  ('NZ', 'New Zealand',    'en', 'Pacific/Auckland',   'NZD', '$',  0, '[]'),
  ('IT', 'Italy',          'it', 'Europe/Rome',        'EUR', '€',  1, '[]'),
  ('JP', 'Japan',          'ja', 'Asia/Tokyo',         'JPY', '¥',  0, '[]'),

  -- Moderate Tier
  ('ES', 'Spain',          'es', 'Europe/Madrid',      'EUR', '€',  1, '[]'),
  ('PL', 'Poland',         'pl', 'Europe/Warsaw',      'PLN', 'zł', 1, '[]'),

  -- Emerging Tier
  ('CN', 'China',          'zh', 'Asia/Shanghai',      'CNY', '¥',  0, '[]'),
  ('MX', 'Mexico',         'es', 'America/Mexico_City','MXN', '$',  0,
    '["AG","BC","BS","CM","CS","CH","CO","CL","DF","DG","GT","GR","HG","JC","EM","MI","MO","NA","NL","OA","PU","QT","QR","SL","SI","SO","TB","TM","TL","VE","YU","ZA"]'),

  -- Developing Tier
  ('ID', 'Indonesia',      'id', 'Asia/Jakarta',       'IDR', 'Rp', 0, '[]'),
  ('IN', 'India',          'en', 'Asia/Kolkata',       'INR', '₹',  0,
    '["AN","AP","AR","AS","BR","CH","CG","DD","DL","DN","GA","GJ","HR","HP","JK","JH","KA","KL","LA","LD","MP","MH","MN","ML","MZ","NL","OD","PY","PB","RJ","SK","TN","TS","TR","UP","UK","WB"]');

CREATE TRIGGER IF NOT EXISTS update_countries_timestamp
AFTER UPDATE ON countries
BEGIN
  UPDATE countries SET updated_at = datetime('now') WHERE country_code = NEW.country_code;
END;
