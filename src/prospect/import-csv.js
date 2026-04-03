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
import { run } from '../utils/db.js';

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

let inserted = 0;
for (const row of rows) {
  const result = await run(
    `INSERT INTO sites (
      business_name, city, state, country_code, phone, email,
      website_url, instagram_handle, facebook_page_url,
      google_rating, review_count, best_review_text, best_review_author,
      niche, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12, $13,
      $14, 'found'
    )
    ON CONFLICT DO NOTHING`,
    [
      row.business_name || row.name,
      row.city || null,
      row.state || null,
      row.country_code || row.country || null,
      row.phone || null,
      row.email || null,
      row.website_url || row.website || null,
      row.instagram_handle || row.instagram || null,
      row.facebook_page_url || row.facebook || null,
      row.google_rating ? parseFloat(row.google_rating) : null,
      row.review_count ? parseInt(row.review_count, 10) : null,
      row.best_review_text || row.review || null,
      row.best_review_author || null,
      row.niche || row.category || null,
    ]
  );
  if (result.changes > 0) inserted++;
}

console.log(`Imported ${inserted} sites from ${rows.length} CSV rows.`);
