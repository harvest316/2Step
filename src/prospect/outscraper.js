#!/usr/bin/env node

/**
 * Outscraper Google Maps prospect finder.
 *
 * Finds local businesses via Outscraper API, filters by rating/reviews,
 * fetches their best 5-star review, and saves to SQLite.
 *
 * Usage:
 *   node src/prospect/outscraper.js --query "pest control" --location "Sydney, NSW" --limit 15
 *   node src/prospect/outscraper.js --query "plumber" --location "Melbourne, VIC" --country AU
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.OUTSCRAPER_API_KEY;
const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const MIN_RATING = parseFloat(process.env.MIN_GOOGLE_RATING || '4.0');
const MIN_REVIEWS = parseInt(process.env.MIN_REVIEW_COUNT || '30', 10);

const BASE_URL = 'https://api.app.outscraper.com';

// ─── CLI Args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    query: { type: 'string', short: 'q' },
    location: { type: 'string', short: 'l' },
    limit: { type: 'string', default: '20' },
    country: { type: 'string', short: 'c', default: 'AU' },
    'skip-reviews': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!args.query || !args.location) {
  console.error('Usage: node src/prospect/outscraper.js --query "pest control" --location "Sydney, NSW"');
  console.error('Options:');
  console.error('  --query, -q       Business type to search for (required)');
  console.error('  --location, -l    City/area to search in (required)');
  console.error('  --limit           Max results to fetch (default: 20)');
  console.error('  --country, -c     Country code (default: AU)');
  console.error('  --skip-reviews    Skip fetching reviews (faster, no best_review)');
  console.error('  --dry-run         Show results without saving to DB');
  process.exit(1);
}

if (!API_KEY) {
  console.error('ERROR: OUTSCRAPER_API_KEY not set. Add it to .env');
  console.error('Sign up at https://outscraper.com/ (free tier: 25 requests)');
  process.exit(1);
}

// ─── Outscraper API ──────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'X-API-KEY': API_KEY },
  timeout: 60000,
});

/**
 * Search Google Maps for businesses.
 */
async function searchBusinesses(query, location, limit) {
  const searchQuery = `${query} ${location}`;
  console.log(`Searching: "${searchQuery}" (limit: ${limit})`);

  const { data } = await api.get('/maps/search-v3', {
    params: {
      query: searchQuery,
      limit,
      language: 'en',
      region: args.country,
    },
  });

  // Outscraper returns nested arrays: [[result1, result2, ...]]
  const results = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : data;
  console.log(`Raw results: ${results.length}`);
  return results;
}

/**
 * Fetch reviews for a business via Outscraper Reviews API.
 * Returns the best 5-star review (longest, most specific).
 */
async function fetchBestReview(placeId, businessName) {
  try {
    const { data } = await api.get('/maps/reviews-v3', {
      params: {
        query: placeId,
        reviewsLimit: 20,
        sort: 'highest_rating',
        language: 'en',
      },
    });

    const place = Array.isArray(data) && Array.isArray(data[0]) ? data[0][0] : data[0];
    const reviews = place?.reviews_data || [];

    // Pick the best 5-star review: longest text, most specific
    const fiveStars = reviews.filter(r => r.review_rating === 5 && r.review_text?.length > 30);

    if (fiveStars.length === 0) {
      console.log(`  No substantial 5-star reviews for ${businessName}`);
      return null;
    }

    // Sort by text length descending — longer reviews tend to be more specific
    fiveStars.sort((a, b) => (b.review_text?.length || 0) - (a.review_text?.length || 0));

    const best = fiveStars[0];
    return {
      text: best.review_text,
      author: best.author_title || best.author_name || 'Anonymous',
    };
  } catch (err) {
    console.warn(`  Failed to fetch reviews for ${businessName}: ${err.message}`);
    return null;
  }
}

/**
 * Extract social handles from Outscraper result.
 */
function extractSocials(result) {
  let instagram = null;
  let facebook = null;

  // Outscraper may return social links in various fields
  const socialLinks = [
    ...(result.social_media || []),
    result.facebook_url,
    result.instagram_url,
  ].filter(Boolean);

  for (const link of socialLinks) {
    const url = typeof link === 'string' ? link : link?.url;
    if (!url) continue;

    if (url.includes('instagram.com/')) {
      const match = url.match(/instagram\.com\/([^/?#]+)/);
      if (match) instagram = match[1];
    }
    if (url.includes('facebook.com/')) {
      facebook = url;
    }
  }

  return { instagram, facebook };
}

/**
 * Map Outscraper result to our prospect schema.
 */
function mapToProspect(result) {
  const { instagram, facebook } = extractSocials(result);

  return {
    business_name: result.name || result.title,
    google_maps_url: result.google_maps_url || result.place_url,
    website_url: result.site || result.website,
    phone: result.phone || result.us_phone,
    email: result.email_1 || result.email,
    instagram_handle: instagram,
    facebook_page_url: facebook,
    city: result.city || result.borough,
    state: result.state,
    country_code: args.country,
    google_rating: result.rating,
    review_count: result.reviews || result.reviews_count,
    niche: args.query,
  };
}

// ─── Database ────────────────────────────────────────────────────────────────

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function insertProspect(db, prospect) {
  const stmt = db.prepare(`
    INSERT INTO prospects (
      business_name, google_maps_url, website_url, phone, email,
      instagram_handle, facebook_page_url, city, state, country_code,
      google_rating, review_count, best_review_text, best_review_author,
      niche, status
    ) VALUES (
      @business_name, @google_maps_url, @website_url, @phone, @email,
      @instagram_handle, @facebook_page_url, @city, @state, @country_code,
      @google_rating, @review_count, @best_review_text, @best_review_author,
      @niche, 'found'
    )
  `);

  return stmt.run(prospect);
}

function isDuplicate(db, businessName, city) {
  const row = db.prepare(
    'SELECT id FROM prospects WHERE business_name = ? AND city = ?'
  ).get(businessName, city);
  return !!row;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const limit = parseInt(args.limit, 10);

  // 1. Search for businesses
  const results = await searchBusinesses(args.query, args.location, limit);

  // 2. Filter by rating and review count
  const filtered = results.filter(r => {
    const rating = r.rating || 0;
    const reviews = r.reviews || r.reviews_count || 0;
    if (rating < MIN_RATING) return false;
    if (reviews < MIN_REVIEWS) return false;
    return true;
  });

  console.log(`After filtering (rating >= ${MIN_RATING}, reviews >= ${MIN_REVIEWS}): ${filtered.length}`);

  if (filtered.length === 0) {
    console.log('No businesses match filters. Try lowering MIN_GOOGLE_RATING or MIN_REVIEW_COUNT.');
    return;
  }

  // 3. Map to prospects and fetch reviews
  const prospects = [];
  for (const result of filtered) {
    const prospect = mapToProspect(result);

    // Fetch best review unless --skip-reviews
    if (!args['skip-reviews']) {
      const placeId = result.place_id || result.google_id;
      if (placeId) {
        const review = await fetchBestReview(placeId, prospect.business_name);
        if (review) {
          prospect.best_review_text = review.text;
          prospect.best_review_author = review.author;
        }
      }
    }

    prospects.push(prospect);
    console.log(`  ✓ ${prospect.business_name} — ${prospect.google_rating}★ (${prospect.review_count} reviews)${prospect.best_review_text ? ' [has review]' : ''}`);
  }

  // 4. Save to DB (or dry-run)
  if (args['dry-run']) {
    console.log('\n--- DRY RUN — not saving to database ---');
    console.log(JSON.stringify(prospects, null, 2));
    return;
  }

  const db = getDb();
  let inserted = 0;
  let skipped = 0;

  for (const prospect of prospects) {
    if (isDuplicate(db, prospect.business_name, prospect.city)) {
      console.log(`  Skip (duplicate): ${prospect.business_name}`);
      skipped++;
      continue;
    }
    insertProspect(db, prospect);
    inserted++;
  }

  db.close();
  console.log(`\nDone: ${inserted} inserted, ${skipped} skipped (duplicates)`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
