#!/usr/bin/env node
/**
 * Re-fetch reviews for prospects with generic pest reviews.
 * Searches Outscraper by business name + city, fetches up to 100 reviews,
 * picks the best pest-specific one, and updates best_review_text in DB.
 *
 * Usage: node scripts/refetch-reviews.js [--dry-run]
 */

import '../src/utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { detectPestFromReview } from '../src/video/shotstack-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const API_KEY = process.env.OUTSCRAPER_API_KEY;
if (!API_KEY) { console.error('OUTSCRAPER_API_KEY not set'); process.exit(1); }

const { values: args } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } }, strict: false });

const api = axios.create({
  baseURL: 'https://api.app.outscraper.com',
  headers: { 'X-API-KEY': API_KEY },
  timeout: 60000,
});

async function pollJob(url, label, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    const { data } = await axios.get(url, { headers: { 'X-API-KEY': API_KEY }, timeout: 30000 });
    if (data.status === 'Success') return data.data;
    if (data.status === 'Error') throw new Error(`Job failed: ${data.error_message}`);
    process.stdout.write('.');
  }
  throw new Error(`Job timed out (${label})`);
}

const PEST_KEYWORDS = [
  'termite', 'termites', 'cockroach', 'cockroaches', 'spider', 'spiders',
  'ant', 'ants', 'rodent', 'rodents', 'rat', 'rats', 'mouse', 'mice',
  'flea', 'fleas', 'wasp', 'wasps', 'bed bug', 'bed bugs', 'mosquito',
  'mosquitoes', 'possum', 'possums', 'silverfish', 'moth', 'moths',
];

function scoreReview(text) {
  const t = (text || '').toLowerCase();
  const hits = PEST_KEYWORDS.filter(kw => t.includes(kw)).length;
  return hits * 1000 + (text?.length || 0);
}

async function searchPlace(businessName, city) {
  const q = `${businessName} ${city} Australia`;
  process.stdout.write(`  Searching: "${q}"...`);
  const { data } = await api.get('/maps/search-v3', {
    params: { query: q, limit: 3, language: 'en', region: 'AU' },
  });
  let raw;
  if (data.status === 'Pending' && data.results_location) {
    const jobData = await pollJob(data.results_location, q);
    raw = Array.isArray(jobData) && Array.isArray(jobData[0]) ? jobData[0] : jobData;
  } else {
    raw = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : data;
  }
  console.log(` ${Array.isArray(raw) ? raw.length : 0} result(s)`);
  return Array.isArray(raw) ? raw : [];
}

async function fetchReviews(placeId, businessName) {
  process.stdout.write(`  Fetching reviews for ${businessName}...`);
  const { data } = await api.get('/maps/reviews-v3', {
    params: { query: placeId, reviewsLimit: 100, sort: 'highest_rating', language: 'en' },
  });
  let placeData;
  if (data.status === 'Pending' && data.results_location) {
    const jobData = await pollJob(data.results_location, businessName, 120000);
    placeData = Array.isArray(jobData) && Array.isArray(jobData[0]) ? jobData[0][0]
      : (Array.isArray(jobData) ? jobData[0] : jobData);
  } else {
    placeData = Array.isArray(data) && Array.isArray(data[0]) ? data[0][0] : data[0];
  }
  const reviews = placeData?.reviews_data || [];
  console.log(` ${reviews.length} reviews`);
  return reviews;
}

async function main() {
  const db = new Database(resolve(root, 'db/2step.db'));

  // Get all pest control prospects with generic reviews
  const prospects = db.prepare(`
    SELECT id, business_name, city, best_review_text, best_review_author
    FROM prospects
    WHERE niche = 'pest control'
    AND id IN (1,3,6,8,9,10,11,12,13)
    ORDER BY id
  `).all();

  console.log(`Re-fetching reviews for ${prospects.length} prospects...\n`);

  let updated = 0;
  for (const p of prospects) {
    console.log(`[${p.id}] ${p.business_name} (${p.city})`);

    // Step 1: search for place to get place_id
    const places = await searchPlace(p.business_name, p.city);
    if (!places.length) {
      console.log('  ✗ No place found\n');
      continue;
    }

    const place = places[0];
    const placeId = place.place_id || place.google_id;
    if (!placeId) {
      console.log(`  ✗ No place_id in result (keys: ${Object.keys(place).join(', ')})\n`);
      continue;
    }
    console.log(`  Found: "${place.name}" (${place.rating}★, ${place.reviews} reviews)`);

    // Step 2: fetch up to 100 reviews
    const reviews = await fetchReviews(placeId, p.business_name);
    const fiveStars = reviews.filter(r => r.review_rating === 5 && (r.review_text?.length || 0) > 30);

    if (!fiveStars.length) {
      console.log('  ✗ No substantial 5-star reviews\n');
      continue;
    }

    // Step 3: score and pick best
    fiveStars.sort((a, b) => scoreReview(b.review_text) - scoreReview(a.review_text));
    const best = fiveStars[0];
    const pest = detectPestFromReview(best.review_text || '');
    const snippet = (best.review_text || '').slice(0, 100).replace(/\n/g, ' ');

    console.log(`  Best review (score ${scoreReview(best.review_text)}, pest=${pest || 'none'}):`);
    console.log(`  "${snippet}..."`);
    console.log(`  Author: ${best.author_title || best.author_name || 'Anonymous'}`);

    if (pest) {
      if (args['dry-run']) {
        console.log(`  ✓ Would update to pest-specific review (${pest})\n`);
      } else {
        db.prepare(`
          UPDATE prospects SET best_review_text = ?, best_review_author = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(best.review_text, best.author_title || best.author_name || 'Anonymous', p.id);
        console.log(`  ✓ Updated — pest: ${pest}\n`);
        updated++;
      }
    } else {
      console.log(`  ~ Best available is still generic (no pest keyword) — not updating\n`);
    }
  }

  db.close();
  console.log(`Done: ${updated} updated${args['dry-run'] ? ' (dry run — no changes written)' : ''}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
