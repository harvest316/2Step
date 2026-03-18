/**
 * Reviews pipeline stage.
 *
 * Two-step Outscraper discovery:
 *   Step 1 — Maps search by "niche + location" → businesses filtered by rating/reviews.
 *   Step 2 — Reviews API per business, keyword-filtered, to find one qualifying review.
 *
 * The stage can be driven from the `keywords` table (pipeline mode) or via CLI args
 * (manual run mode).
 *
 * Costs (approximate):
 *   Step 1: ~$2 / 1 000 results
 *   Step 2: ~$2 / 1 000 reviews
 *
 * Usage (manual):
 *   node src/stages/reviews.js --keyword "pest control" --location "Sydney" --country AU
 *   node src/stages/reviews.js --keyword "plumber" --location "Melbourne" --limit 50 --dry-run
 *
 * Export:
 *   runReviewsStage(options?) → { searched, found, inserted, skipped, errors }
 */

import '../utils/load-env.js';
import axios from 'axios';
import { parseArgs } from 'util';
import db from '../utils/db.js';
import { matchCategory, buildReviewQueryString } from '../config/problem-categories.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY        = process.env.OUTSCRAPER_API_KEY;
const BASE_URL       = 'https://api.app.outscraper.com';
const MIN_RATING     = parseFloat(process.env.MIN_GOOGLE_RATING  || '4.0');
const MIN_REVIEWS    = parseInt(process.env.MIN_REVIEW_COUNT     || '30', 10);
const MIN_WORD_COUNT = parseInt(process.env.MIN_REVIEW_WORDS     || '30', 10);

// ─── Outscraper HTTP client ───────────────────────────────────────────────────

function makeApi() {
  if (!API_KEY) {
    throw new Error('OUTSCRAPER_API_KEY is not set. Add it to .env');
  }
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'X-API-KEY': API_KEY },
    timeout: 60_000,
  });
}

// ─── Outscraper polling ───────────────────────────────────────────────────────

/**
 * Poll an async Outscraper job until it completes or times out.
 *
 * @param {string} resultsLocation - URL returned by Outscraper for the pending job
 * @param {string} label           - Human label for log messages
 * @param {number} maxWaitMs       - Timeout in ms (default 120s)
 * @returns {Promise<Array>}        Raw `data` array from the completed job
 */
async function pollJob(resultsLocation, label, maxWaitMs = 120_000) {
  const start = Date.now();
  const interval = 3_000;

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, interval));

    const { data } = await axios.get(resultsLocation, {
      headers: { 'X-API-KEY': API_KEY },
      timeout: 30_000,
    });

    if (data.status === 'Success') return data.data;
    if (data.status === 'Error') {
      throw new Error(`Outscraper job failed (${label}): ${data.error_message || 'unknown error'}`);
    }

    process.stdout.write('.');
  }

  throw new Error(`Outscraper job timed out after ${maxWaitMs / 1000}s (${label})`);
}

// ─── Step 1: Business discovery ───────────────────────────────────────────────

/**
 * Search Google Maps for businesses matching "keyword location".
 *
 * @param {import('axios').AxiosInstance} api
 * @param {string} keyword      - e.g. "pest control"
 * @param {string} location     - e.g. "Sydney"
 * @param {string} countryCode  - ISO 3166-1 alpha-2, e.g. "AU"
 * @param {number} limit        - Max results to request
 * @returns {Promise<Object[]>} Raw Outscraper result array
 */
async function searchBusinesses(api, keyword, location, countryCode, limit) {
  const query = `${keyword} ${location}`.trim();
  console.log(`[reviews] Searching Maps: "${query}" (limit: ${limit}, country: ${countryCode})`);

  const { data } = await api.get('/maps/search-v3', {
    params: { query, limit, language: 'en', region: countryCode },
  });

  let raw;
  if (data.status === 'Pending' && data.results_location) {
    process.stdout.write('  Waiting');
    const jobData = await pollJob(data.results_location, query);
    console.log('');
    raw = Array.isArray(jobData?.[0]) ? jobData[0] : (jobData ?? []);
  } else {
    raw = Array.isArray(data?.[0]) ? data[0] : (data ?? []);
  }

  const results = Array.isArray(raw) ? raw : [];
  console.log(`[reviews] Raw results: ${results.length}`);
  return results;
}

// ─── Step 2: Review download ──────────────────────────────────────────────────

/**
 * Fetch one keyword-matching review for a business.
 *
 * Passes a query string built from niche category keywords to Outscraper's
 * `query` parameter so the API filters results server-side, minimising cost.
 * We then verify locally: the review must have >= MIN_WORD_COUNT words.
 *
 * @param {import('axios').AxiosInstance} api
 * @param {string} placeId      - Google place_id / google_id
 * @param {string} businessName - For logging
 * @param {string} niche        - e.g. "pest control"
 * @returns {Promise<{ text: string, author: string, rating: number, category: string } | null>}
 */
async function fetchMatchingReview(api, placeId, businessName, niche) {
  const reviewQuery = buildReviewQueryString(niche);

  try {
    const { data } = await api.get('/maps/reviews-v3', {
      params: {
        query:        placeId,
        reviewsLimit: 1,
        sort:         'highest_rating',
        language:     'en',
        // Pass niche keywords so Outscraper pre-filters review content
        cutReviewsAfter: reviewQuery,
      },
    });

    let placeData;
    if (data.status === 'Pending' && data.results_location) {
      process.stdout.write('    Fetching review');
      const jobData = await pollJob(data.results_location, businessName, 60_000);
      console.log('');
      placeData = Array.isArray(jobData?.[0]) ? jobData[0][0] : (jobData?.[0] ?? null);
    } else {
      placeData = Array.isArray(data?.[0]) ? data[0][0] : (data?.[0] ?? null);
    }

    const reviews = placeData?.reviews_data ?? [];

    for (const r of reviews) {
      const text   = r.review_text ?? '';
      const rating = r.review_rating ?? 0;

      // Word count gate
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount < MIN_WORD_COUNT) continue;

      // Category match gate
      const match = matchCategory(niche, text);
      if (!match) continue;

      return {
        text,
        author:   r.author_title || r.author_name || 'Anonymous',
        rating,
        category: match.category,
      };
    }

    console.log(`[reviews]   No qualifying review for "${businessName}"`);
    return null;
  } catch (err) {
    console.warn(`[reviews]   Review fetch failed for "${businessName}": ${err.message}`);
    return null;
  }
}

// ─── Social extraction ────────────────────────────────────────────────────────

function extractSocials(result) {
  let instagram = null;
  let facebook  = null;

  const links = [
    ...(result.social_media ?? []),
    result.facebook_url,
    result.instagram_url,
  ].filter(Boolean);

  for (const entry of links) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (!url) continue;
    if (url.includes('instagram.com/')) {
      const m = url.match(/instagram\.com\/([^/?#]+)/);
      if (m) instagram = m[1];
    }
    if (url.includes('facebook.com/')) facebook = url;
  }

  return { instagram, facebook };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Check whether a google_place_id already exists in the sites table.
 */
const stmtExistsByPlaceId = db.prepare(
  'SELECT id FROM sites WHERE google_place_id = ?'
);

/**
 * Fallback duplicate check when place_id is not available.
 */
const stmtExistsByName = db.prepare(
  'SELECT id FROM sites WHERE business_name = ? AND city = ?'
);

function isDuplicate(placeId, businessName, city) {
  if (placeId) {
    return !!stmtExistsByPlaceId.get(placeId);
  }
  return !!stmtExistsByName.get(businessName, city ?? '');
}

const stmtInsertSite = db.prepare(`
  INSERT INTO sites (
    business_name, google_maps_url, website_url, phone, email,
    instagram_handle, facebook_page_url, city, state, country_code,
    google_rating, review_count, niche, keyword,
    google_place_id, selected_review_json, problem_category,
    status
  ) VALUES (
    @business_name, @google_maps_url, @website_url, @phone, @email,
    @instagram_handle, @facebook_page_url, @city, @state, @country_code,
    @google_rating, @review_count, @niche, @keyword,
    @google_place_id, @selected_review_json, @problem_category,
    'reviews_downloaded'
  )
`);

const stmtUpdateKeyword = db.prepare(`
  UPDATE keywords
  SET search_count      = search_count + 1,
      sites_found_count = sites_found_count + @delta,
      last_searched_at  = CURRENT_TIMESTAMP,
      updated_at        = CURRENT_TIMESTAMP
  WHERE id = @id
`);

// ─── Core stage logic ─────────────────────────────────────────────────────────

/**
 * Process one keyword — search, filter, dedup, fetch reviews, insert.
 *
 * @param {import('axios').AxiosInstance} api
 * @param {{ id?: number, keyword: string, location: string, country_code: string, niche?: string }} kwRow
 * @param {number} limit
 * @param {boolean} dryRun
 * @returns {Promise<{ searched: number, found: number, inserted: number, skipped: number, errors: number }>}
 */
async function processKeyword(api, kwRow, limit, dryRun) {
  const stats = { searched: 0, found: 0, inserted: 0, skipped: 0, errors: 0 };

  const { keyword, location, country_code: countryCode, niche } = kwRow;
  // Derive niche from keyword if not set (first two words or the whole thing)
  const resolvedNiche = (niche || keyword).toLowerCase();

  // Step 1 — search
  let rawResults;
  try {
    rawResults = await searchBusinesses(api, keyword, location, countryCode, limit);
  } catch (err) {
    console.error(`[reviews] Maps search failed for "${keyword} ${location}": ${err.message}`);
    stats.errors++;
    return stats;
  }

  stats.searched = rawResults.length;

  // Filter by rating + review count
  const filtered = rawResults.filter(r => {
    const rating  = r.rating ?? 0;
    const reviews = r.reviews ?? r.reviews_count ?? 0;
    return rating >= MIN_RATING && reviews >= MIN_REVIEWS;
  });

  console.log(`[reviews] After filter (>= ${MIN_RATING}★, >= ${MIN_REVIEWS} reviews): ${filtered.length}`);
  stats.found = filtered.length;

  // Step 2 — per business: dedup → fetch review → insert
  for (const result of filtered) {
    const placeId      = result.place_id ?? result.google_id ?? null;
    const businessName = result.name ?? result.title ?? '(unknown)';
    const city         = result.city ?? result.borough ?? null;

    // Dedup
    if (isDuplicate(placeId, businessName, city)) {
      console.log(`[reviews]   Skip (dup): ${businessName}`);
      stats.skipped++;
      continue;
    }

    // Fetch review
    let review = null;
    if (placeId) {
      review = await fetchMatchingReview(api, placeId, businessName, resolvedNiche);
    } else {
      console.warn(`[reviews]   No place_id for "${businessName}" — skipping review fetch`);
    }

    if (!review) {
      stats.skipped++;
      continue;
    }

    // Build site row
    const { instagram, facebook } = extractSocials(result);

    const site = {
      business_name:       businessName,
      google_maps_url:     result.google_maps_url ?? result.place_url ?? null,
      website_url:         result.site ?? result.website ?? null,
      phone:               result.phone ?? result.us_phone ?? null,
      email:               result.email_1 ?? result.email ?? null,
      instagram_handle:    instagram,
      facebook_page_url:   facebook,
      city,
      state:               result.state ?? null,
      country_code:        countryCode,
      google_rating:       result.rating ?? null,
      review_count:        result.reviews ?? result.reviews_count ?? null,
      niche:               resolvedNiche,
      keyword,
      google_place_id:     placeId,
      selected_review_json: JSON.stringify({
        text:   review.text,
        author: review.author,
        rating: review.rating,
      }),
      problem_category:    review.category,
    };

    if (dryRun) {
      console.log(`[reviews]   [DRY RUN] Would insert: ${businessName} — category: ${review.category}`);
      stats.inserted++;
      continue;
    }

    try {
      stmtInsertSite.run(site);
      console.log(`[reviews]   Inserted: ${businessName} — category: ${review.category}`);
      stats.inserted++;
    } catch (err) {
      console.error(`[reviews]   Insert failed for "${businessName}": ${err.message}`);
      stats.errors++;
    }
  }

  // Update keyword row stats (skip on dry-run or if no DB id)
  if (!dryRun && kwRow.id) {
    try {
      stmtUpdateKeyword.run({ id: kwRow.id, delta: stats.inserted });
    } catch (err) {
      // Non-fatal
      console.warn(`[reviews] Failed to update keyword stats for id=${kwRow.id}: ${err.message}`);
    }
  }

  return stats;
}

// ─── Exported stage function ──────────────────────────────────────────────────

/**
 * Run the reviews discovery stage.
 *
 * Options can be supplied directly (for programmatic invocation) or
 * the stage will read `status IN ('pending','active')` keywords from the DB.
 *
 * @param {Object} [options]
 * @param {number}  [options.limit=50]        Max businesses per keyword search
 * @param {string}  [options.keyword]         Force a specific keyword string
 * @param {string}  [options.location]        Location component (e.g. "Sydney")
 * @param {string}  [options.countryCode='AU'] ISO country code
 * @param {string}  [options.niche]           Override niche for category matching
 * @param {boolean} [options.dryRun=false]    Skip DB writes
 * @returns {Promise<{ searched: number, found: number, inserted: number, skipped: number, errors: number }>}
 */
export async function runReviewsStage(options = {}) {
  const {
    limit       = 50,
    keyword     = null,
    location    = null,
    countryCode = 'AU',
    niche       = null,
    dryRun      = false,
  } = options;

  if (!process.env.OUTSCRAPER_API_KEY) {
    throw new Error('OUTSCRAPER_API_KEY is not set');
  }

  const api = makeApi();

  const totals = { searched: 0, found: 0, inserted: 0, skipped: 0, errors: 0 };

  // Build keyword list
  let keywords;

  if (keyword) {
    // Direct invocation — single keyword
    keywords = [{
      id:           null,
      keyword,
      location:     location ?? '',
      country_code: countryCode,
      niche,
    }];
  } else {
    // Pipeline mode — pull from keywords table
    keywords = db.prepare(`
      SELECT id, keyword, location, country_code
      FROM keywords
      WHERE status IN ('active', 'pending')
      ORDER BY priority DESC, last_searched_at ASC NULLS FIRST
    `).all();

    if (keywords.length === 0) {
      console.log('[reviews] No active/pending keywords in DB. Nothing to do.');
      return totals;
    }
    console.log(`[reviews] Processing ${keywords.length} keyword(s) from DB`);
  }

  for (const kwRow of keywords) {
    console.log(`\n[reviews] ─── Keyword: "${kwRow.keyword}" / ${kwRow.location ?? ''} (${kwRow.country_code}) ───`);

    const stats = await processKeyword(api, kwRow, limit, dryRun);

    totals.searched += stats.searched;
    totals.found    += stats.found;
    totals.inserted += stats.inserted;
    totals.skipped  += stats.skipped;
    totals.errors   += stats.errors;
  }

  console.log('\n[reviews] Stage complete:', totals);
  return totals;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('reviews.js')) {
  const { values: args } = parseArgs({
    options: {
      keyword:  { type: 'string',  short: 'k' },
      location: { type: 'string',  short: 'l' },
      country:  { type: 'string',  short: 'c', default: 'AU' },
      niche:    { type: 'string',  short: 'n' },
      limit:    { type: 'string',               default: '50' },
      'dry-run':{ type: 'boolean',              default: false },
    },
    strict: false,
  });

  if (!args.keyword && !args.location) {
    // Pipeline mode — pull from DB
    console.log('[reviews] No --keyword supplied; running in pipeline mode (reads from keywords table)');
  } else if (!args.keyword || !args.location) {
    console.error('Usage: node src/stages/reviews.js --keyword "pest control" --location "Sydney" [--country AU] [--limit 50] [--dry-run]');
    process.exit(1);
  }

  runReviewsStage({
    keyword:     args.keyword  ?? null,
    location:    args.location ?? null,
    countryCode: args.country,
    niche:       args.niche    ?? null,
    limit:       parseInt(args.limit, 10),
    dryRun:      args['dry-run'],
  }).catch(err => {
    console.error('[reviews] Fatal:', err.message);
    process.exit(1);
  });
}
