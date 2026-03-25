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
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from '../utils/db.js';
import { matchCategory } from '../config/problem-categories.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY        = process.env.OUTSCRAPER_API_KEY;
const BASE_URL       = 'https://api.app.outscraper.com';
const MIN_RATING     = parseFloat(process.env.MIN_GOOGLE_RATING  || '4.0');
const MIN_REVIEWS    = parseInt(process.env.MIN_REVIEW_COUNT     || '30', 10);
const MIN_WORD_COUNT = parseInt(process.env.MIN_REVIEW_WORDS     || '30', 10);

const CONCURRENCY   = 5;   // max parallel Outscraper review-fetch requests
const FETCH_LADDER  = [2, 10, 25, 50, 100]; // escalating reviewsLimit per attempt

// ─── Review criteria loader ───────────────────────────────────────────────────

/**
 * Load review-criteria config for a country + niche.
 * Falls back to AU if no country-specific file exists.
 *
 * Returns { problems: { [name]: { clip_pool, query_terms[] } } }
 * or null if no config found.
 */
function loadReviewCriteria(countryCode, niche) {
  const slug = niche.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
  const base  = resolve(__dirname, '../../data/review-criteria');
  const paths = [
    resolve(base, countryCode.toUpperCase(), `${slug}.json`),
    resolve(base, 'AU', `${slug}.json`),  // fallback
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        console.warn(`[reviews] Failed to parse ${p}: ${e.message}`);
      }
    }
  }
  return null;
}

/**
 * Build the Outscraper reviewsQuery string from all problems in a criteria config.
 * Terms are joined with spaces (Outscraper uses implicit OR).
 */
function buildQueryFromCriteria(criteria) {
  const terms = new Set();
  for (const problem of Object.values(criteria.problems)) {
    for (const t of (problem.query_terms || [])) terms.add(t);
  }
  return [...terms].join(' ');
}

// ─── Simple concurrency semaphore ────────────────────────────────────────────

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return function acquire() {
    return new Promise(resolve => {
      const tryRun = () => {
        if (active < limit) { active++; resolve(() => { active--; const next = queue.shift(); if (next) next(); }); }
        else queue.push(tryRun);
      };
      tryRun();
    });
  };
}

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
 * Score a review for suitability — higher is better.
 * Keyword hits are weighted heavily so a short but specific review can beat a
 * long but generic one.
 */
function scoreReview(text, niche) {
  const match = matchCategory(niche, text);
  if (!match) return -1;  // no category match = disqualified
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) return -1;  // too short = disqualified
  return match.hits * 1000 + wordCount;
}

/**
 * Fetch the best keyword-matching 5-star review for a business.
 *
 * Uses escalating reviewsLimit (FETCH_LADDER) to minimise credit spend:
 *   - Fetch 2 → score all → if a winner found, done (2 credits)
 *   - Otherwise fetch 10 → score new reviews → if winner, done (10 credits total)
 *   - Continue up the ladder until a winner is found or all batches exhausted.
 *
 * NOTE: Outscraper has no offset parameter — each call always returns the FIRST N
 * reviews. We track which review_ids we've already scored and skip them.
 *
 * @param {import('axios').AxiosInstance} api
 * @param {string} placeId        - Google place_id / google_id
 * @param {string} businessName   - For logging
 * @param {string} niche          - e.g. "pest control"
 * @param {string} reviewsQuery   - Space-joined keyword stems (Outscraper implicit OR)
 * @param {string} countryCode    - ISO 3166-1 alpha-2
 * @returns {Promise<{ text: string, author: string, rating: number, category: string } | null>}
 */
async function fetchMatchingReview(api, placeId, businessName, niche, reviewsQuery, countryCode) {
  const seenIds = new Set();
  let best = null;

  for (const limit of FETCH_LADDER) {
    let placeData;
    try {
      const { data } = await api.get('/maps/reviews-v3', {
        params: {
          query:         placeId,
          reviewsLimit:  limit,
          cutoffRating:  5,          // 5-star reviews only
          sort:          'most_relevant',
          language:      'en',
          reviewsQuery,              // keyword pre-filter (Outscraper implicit OR)
        },
      });

      if (data.status === 'Pending' && data.results_location) {
        const jobData = await pollJob(data.results_location, businessName, 90_000);
        placeData = Array.isArray(jobData?.[0]) ? jobData[0][0] : (jobData?.[0] ?? null);
      } else {
        placeData = Array.isArray(data?.[0]) ? data[0][0] : (data?.[0] ?? null);
      }
    } catch (err) {
      console.warn(`[reviews]   Review fetch failed for "${businessName}" (limit=${limit}): ${err.message}`);
      break;
    }

    const reviews = placeData?.reviews_data ?? [];
    let newCount = 0;

    for (const r of reviews) {
      const id = r.review_id || r.review_link || `${r.author_title}:${r.review_datetime_utc}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newCount++;

      const text  = r.review_text ?? '';
      const score = scoreReview(text, niche);
      if (score > (best?.score ?? -1)) {
        const match = matchCategory(niche, text);
        best = {
          text,
          author:   r.author_title || r.author_name || 'Anonymous',
          rating:   r.review_rating ?? 5,
          category: match?.category ?? niche,
          score,
        };
      }
    }

    // Found a winner — stop fetching
    if (best) break;

    // No new reviews came in — we've exhausted the pool
    if (newCount === 0) break;

    // Reached the last ladder rung — stop regardless
    if (limit === FETCH_LADDER[FETCH_LADDER.length - 1]) break;
  }

  if (!best) {
    console.log(`[reviews]   No qualifying review for "${businessName}"`);
    return null;
  }

  const { score: _score, ...result } = best;
  return result;
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
  const resolvedNiche = (niche || keyword).toLowerCase();

  // Load review-criteria config for this country + niche
  const criteria = loadReviewCriteria(countryCode || 'AU', resolvedNiche);
  const reviewsQuery = criteria
    ? buildQueryFromCriteria(criteria)
    : resolvedNiche;  // fallback to niche name if no config file

  if (!criteria) {
    console.warn(`[reviews] No review-criteria config for ${countryCode}/${resolvedNiche} — using niche name as query`);
  }

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

  // Step 2 — per business (parallelised, max CONCURRENCY at a time):
  // dedup → fetch review → insert
  const semaphore = makeSemaphore(CONCURRENCY);

  await Promise.allSettled(filtered.map(async (result) => {
    const release      = await semaphore();
    const placeId      = result.place_id ?? result.google_id ?? null;
    const businessName = result.name ?? result.title ?? '(unknown)';
    const city         = result.city ?? result.borough ?? null;

    try {
      // Dedup
      if (isDuplicate(placeId, businessName, city)) {
        console.log(`[reviews]   Skip (dup): ${businessName}`);
        stats.skipped++;
        return;
      }

      // Fetch review
      let review = null;
      if (placeId) {
        review = await fetchMatchingReview(api, placeId, businessName, resolvedNiche, reviewsQuery, countryCode);
      } else {
        console.warn(`[reviews]   No place_id for "${businessName}" — skipping review fetch`);
      }

      if (!review) {
        stats.skipped++;
        return;
      }

      // Build site row
      const { instagram, facebook } = extractSocials(result);

      const site = {
        business_name:        businessName,
        google_maps_url:      result.google_maps_url ?? result.place_url ?? null,
        website_url:          result.site ?? result.website ?? null,
        phone:                result.phone ?? result.us_phone ?? null,
        email:                result.email_1 ?? result.email ?? null,
        instagram_handle:     instagram,
        facebook_page_url:    facebook,
        city,
        state:                result.state ?? null,
        country_code:         countryCode,
        google_rating:        result.rating ?? null,
        review_count:         result.reviews ?? result.reviews_count ?? null,
        niche:                resolvedNiche,
        keyword,
        google_place_id:      placeId,
        selected_review_json: JSON.stringify({
          text:   review.text,
          author: review.author,
          rating: review.rating,
        }),
        problem_category:     review.category,
      };

      if (dryRun) {
        console.log(`[reviews]   [DRY RUN] Would insert: ${businessName} — category: ${review.category}`);
        stats.inserted++;
        return;
      }

      try {
        stmtInsertSite.run(site);
        console.log(`[reviews]   Inserted: ${businessName} — category: ${review.category}`);
        stats.inserted++;
      } catch (err) {
        console.error(`[reviews]   Insert failed for "${businessName}": ${err.message}`);
        stats.errors++;
      }
    } finally {
      release();
    }
  }));

  // Update keyword row stats (skip on dry-run or if no DB id)
  if (!dryRun && kwRow.id) {
    try {
      stmtUpdateKeyword.run({ id: kwRow.id, delta: stats.inserted });
    } catch (err) {
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

// ── Test-visible exports for pure helper functions ───────────────────────

export { buildQueryFromCriteria, makeSemaphore, extractSocials, scoreReview, loadReviewCriteria };

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
