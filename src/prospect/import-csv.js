#!/usr/bin/env node

/**
 * CSV import fallback — for when Outscraper isn't set up yet.
 * Import prospects from a CSV file with columns:
 *   business_name, city, state, phone, email, website_url, google_rating, review_count, niche
 *
 * Usage: node src/prospect/import-csv.js data/prospects.csv
 */

import '../utils/load-env.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import db from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const csvPath = process.argv[2];

if (!csvPath) {
  console.error('Usage: node src/prospect/import-csv.js <path-to-csv>');
  console.error('CSV columns: business_name, city, state, phone, email, website_url, google_rating, review_count, niche');
  process.exit(1);
}

const csv = readFileSync(resolve(csvPath), 'utf8');
const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

const stmt = db.prepare(`
  INSERT OR IGNORE INTO sites (
    business_name, city, state, country_code, phone, email,
    website_url, instagram_handle, facebook_page_url,
    google_rating, review_count, best_review_text, best_review_author,
    niche, status
  ) VALUES (
    @business_name, @city, @state, @country_code, @phone, @email,
    @website_url, @instagram_handle, @facebook_page_url,
    @google_rating, @review_count, @best_review_text, @best_review_author,
    @niche, 'found'
  )
`);

let inserted = 0;
for (const row of rows) {
  const result = stmt.run({
    business_name: row.business_name || row.name,
    city: row.city || null,
    state: row.state || null,
    country_code: row.country_code || row.country || 'AU',
    phone: row.phone || null,
    email: row.email || null,
    website_url: row.website_url || row.website || null,
    instagram_handle: row.instagram_handle || row.instagram || null,
    facebook_page_url: row.facebook_page_url || row.facebook || null,
    google_rating: row.google_rating ? parseFloat(row.google_rating) : null,
    review_count: row.review_count ? parseInt(row.review_count, 10) : null,
    best_review_text: row.best_review_text || row.review || null,
    best_review_author: row.best_review_author || null,
    niche: row.niche || row.category || null,
  });
  if (result.changes > 0) inserted++;
}

console.log(`Imported ${inserted} sites from ${rows.length} CSV rows.`);
