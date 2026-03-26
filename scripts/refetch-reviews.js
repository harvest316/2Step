#!/usr/bin/env node
/**
 * Re-fetch reviews for sites with weak/spam/short reviews.
 *
 * Loads vertical-specific keyword criteria from data/review-criteria/{country}/{niche}.json,
 * concatenates all problem query_terms as implicit-OR, then incrementally fetches
 * 2 reviews at a time until a good one is found or all 5-star reviews are exhausted.
 *
 * A "good" review = has keyword hit(s) AND has 4+ extractable sentences (>=15 chars each).
 *
 * Usage:
 *   node scripts/refetch-reviews.js --ids 6,17,18,19,21
 *   node scripts/refetch-reviews.js --ids 6,17,18,19,21 --dry-run
 */

import '../src/utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const API_KEY = process.env.OUTSCRAPER_API_KEY;
if (!API_KEY) { console.error('OUTSCRAPER_API_KEY not set'); process.exit(1); }

const { values: args } = parseArgs({
  options: {
    ids: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!args.ids) { console.error('Usage: --ids 6,17,18,19,21 [--dry-run]'); process.exit(1); }
const siteIds = args.ids.split(',').map(Number);

const api = axios.create({
  baseURL: 'https://api.app.outscraper.com',
  headers: { 'X-API-KEY': API_KEY },
  timeout: 60000,
});

// ─── Outscraper helpers ──────────────────────────────────────────────────────

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

/**
 * Fetch reviews incrementally — 2 at a time.
 * reviewsQuery = all keyword terms concatenated (Outscraper implicit OR).
 * cutoffRating = 5 (only 5-star reviews).
 * Returns reviews in batches until exhausted.
 */
async function fetchReviewsBatch(placeId, businessName, reviewsQuery, offset = 0, limit = 2) {
  process.stdout.write(`  Fetching reviews (offset=${offset}, limit=${limit})...`);
  const params = {
    query: placeId,
    reviewsLimit: limit,
    sort: 'highest_rating',
    cutoffRating: 5,
    language: 'en',
  };
  // NOTE: reviewsQuery + cutoffRating together returns 0 results (Outscraper quirk).
  // Use reviewsQuery alone for keyword filtering, or cutoffRating alone for star filtering.
  // We use cutoffRating=5 only (no reviewsQuery) and score client-side.
  if (offset > 0) params.start = offset;

  const { data } = await api.get('/maps/reviews-v3', { params });
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

// ─── Review quality scoring ──────────────────────────────────────────────────

/**
 * Load review-criteria config for a niche + country.
 * Returns all query_terms concatenated, and a score function.
 */
function loadCriteria(niche, countryCode) {
  // Map niche to criteria file name
  const nicheMap = {
    'pest control': 'pest-control',
    'plumber': 'plumber',
    'plumbing': 'plumber',
    'house cleaning service': 'house-cleaning',
    'cleaning': 'house-cleaning',
    'cleaner': 'house-cleaning',
  };
  const nicheKey = nicheMap[niche.toLowerCase()] || niche.toLowerCase();
  const country = (countryCode || 'AU').toUpperCase();
  const path = resolve(root, `data/review-criteria/${country}/${nicheKey}.json`);

  let criteria;
  try {
    criteria = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.warn(`  ⚠ No criteria file at ${path} — using generic scoring`);
    return { queryTerms: '', scoreReview: (text) => text?.length || 0 };
  }

  // Concatenate all query_terms from all problems (Outscraper implicit OR)
  const allTerms = [];
  const allKeywords = [];
  for (const prob of Object.values(criteria.problems)) {
    for (const term of prob.query_terms) {
      if (!allTerms.includes(term)) allTerms.push(term);
      allKeywords.push(term);
    }
  }
  const queryTerms = allTerms.join(' ');

  // Score function: keyword hits * 1000 + text length
  const scoreReview = (text) => {
    const t = (text || '').toLowerCase();
    const hits = allKeywords.filter(kw => t.includes(kw)).length;
    return hits * 1000 + t.length;
  };

  return { queryTerms, scoreReview };
}

/**
 * Count extractable sentences (>=15 chars, not starting with a dangling opener).
 */
function countUsableSentences(text) {
  if (!text) return 0;
  const sentences = (text.match(/[^.!?]+[.!?]+/g) || [])
    .map(s => s.trim())
    .filter(s => s.length >= 15);
  return sentences.length;
}

/**
 * Detect if review is spam / word-salad.
 */
function isSpam(text) {
  if (!text) return true;
  // High ratio of rare/nonsensical words = spam
  const words = text.split(/\s+/);
  if (words.length < 10) return false; // too short to judge
  const nonsense = /\b(radish|rainbow|raves|buffers|bulb|cultivating|porch)\b/i;
  const hits = words.filter(w => nonsense.test(w)).length;
  return hits >= 3;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const db = new Database(resolve(root, 'db/2step.db'));

  const sites = db.prepare(`
    SELECT id, business_name, city, country_code, niche, best_review_text, best_review_author
    FROM sites
    WHERE id IN (${siteIds.map(() => '?').join(',')})
    ORDER BY id
  `).all(...siteIds);

  console.log(`Re-fetching reviews for ${sites.length} sites...\n`);
  let updated = 0;

  for (const site of sites) {
    console.log(`[${site.id}] ${site.business_name} (${site.city}, ${site.niche})`);

    const { queryTerms, scoreReview } = loadCriteria(site.niche, site.country_code);
    console.log(`  Query terms: ${queryTerms.slice(0, 80)}${queryTerms.length > 80 ? '...' : ''}`);

    // Step 1: search for place
    const places = await searchPlace(site.business_name, site.city);
    if (!places.length) { console.log('  ✗ No place found\n'); continue; }

    const place = places[0];
    const placeId = place.place_id || place.google_id;
    if (!placeId) { console.log(`  ✗ No place_id\n`); continue; }
    console.log(`  Found: "${place.name}" (${place.rating}★, ${place.reviews} reviews)`);

    // Step 2: fetch 2 reviews at a time, score, stop when good enough
    let bestReview = null;
    let bestScore = 0;
    let bestAuthor = null;
    let totalFetched = 0;
    const maxReviews = 20; // safety cap — don't fetch more than 20 total
    const seenTexts = new Set();

    while (totalFetched < maxReviews) {
      const batch = await fetchReviewsBatch(placeId, site.business_name, queryTerms, totalFetched, 2);
      if (!batch.length) { console.log('  No more reviews available'); break; }

      for (const r of batch) {
        const text = r.review_text || '';
        if (seenTexts.has(text)) continue;
        seenTexts.add(text);

        if (text.length < 50) continue;    // too short
        if (isSpam(text)) { console.log(`  ~ Skipping spam review`); continue; }

        const score = scoreReview(text);
        const sentences = countUsableSentences(text);

        if (score > bestScore && sentences >= 4) {
          bestReview = text;
          bestScore = score;
          bestAuthor = r.author_title || r.author_name || 'Anonymous';
          console.log(`  ✓ Candidate (score=${score}, sentences=${sentences}): "${text.slice(0, 80)}..."`);
        }
      }

      totalFetched += batch.length;

      // Good enough? keyword hit + 4+ sentences
      if (bestScore >= 1000) {
        console.log(`  Found keyword-rich review (score=${bestScore}), stopping.`);
        break;
      }

      // If batch returned fewer than requested, we've exhausted results
      if (batch.length < 2) break;
    }

    // Fall back to best available even without keyword hits (if 4+ sentences)
    if (!bestReview) {
      console.log(`  ✗ No suitable review found after ${totalFetched} reviews\n`);
      continue;
    }

    const snippet = bestReview.slice(0, 100).replace(/\n/g, ' ');
    console.log(`  Best: score=${bestScore}, author="${bestAuthor}"`);
    console.log(`  "${snippet}..."`);

    if (args['dry-run']) {
      console.log(`  ✓ Would update\n`);
    } else {
      db.prepare(`
        UPDATE sites SET best_review_text = ?, best_review_author = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(bestReview, bestAuthor, site.id);
      console.log(`  ✓ Updated\n`);
      updated++;
    }
  }

  db.close();
  console.log(`Done: ${updated} updated${args['dry-run'] ? ' (dry run)' : ''}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
