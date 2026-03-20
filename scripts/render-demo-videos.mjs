#!/usr/bin/env node

/**
 * Render demo videos for ACME businesses.
 *
 * Creates 3 demo videos (pest-control, cleaning, plumber) using the full
 * video pipeline (ElevenLabs voiceover + ffmpeg + R2 clips) with fake site data.
 *
 * Outputs: tmp/demo-{slug}.mp4 + scripts/demo-poster-{slug}.jpg
 * Also uploads to R2 and prints the public URLs for demo/index.php.
 *
 * Usage:
 *   node scripts/render-demo-videos.mjs                 # All 3
 *   node scripts/render-demo-videos.mjs pest-control    # Just one
 *   node scripts/render-demo-videos.mjs --dry-run       # Preview without rendering
 */

import '../src/utils/load-env.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

import {
  buildScenes,
  pickClipsFromPool,
} from '../src/video/shotstack-lib.js';
import { processSite } from '../src/stages/video.js';

// ── Demo sites ──────────────────────────────────────────────────────────────

const DEMOS = [
  {
    slug: 'pest-control',
    id: 900001, // fake site IDs in a high range
    business_name: 'ACME Pest Control',
    city: 'Sydney',
    niche: 'pest control',
    country_code: 'AU',
    best_review_author: 'Sarah Mitchell',
    best_review_text: 'Absolutely fantastic service — professional, thorough, and genuinely friendly. They explained everything clearly and the problem was sorted same day. Highly recommend to anyone in Sydney.',
    google_rating: 4.9,
    review_count: 492,
    phone: '0412 345 678',
    problem_category: 'cockroaches',
    logo_url: null, // will use ACME logo
    selected_review_json: JSON.stringify({
      author_name: 'Sarah Mitchell',
      text: 'Absolutely fantastic service — professional, thorough, and genuinely friendly. They explained everything clearly and the problem was sorted same day. Highly recommend to anyone in Sydney.',
      rating: 5,
    }),
  },
  {
    slug: 'cleaning',
    id: 900002,
    business_name: 'ACME Cleaning',
    city: 'Sydney',
    niche: 'house cleaning service',
    country_code: 'AU',
    best_review_author: 'James Thornton',
    best_review_text: 'Best cleaning service we have ever used in Sydney. The team arrived right on time and were incredibly thorough from top to bottom. They left our entire office absolutely spotless, including the kitchen and bathrooms. We have already booked them for weekly cleans going forward. Highly recommend ACME Cleaning to any business looking for reliable cleaners.',
    google_rating: 4.8,
    review_count: 318,
    phone: '0413 456 789',
    problem_category: 'deep-clean',
    logo_url: null,
    selected_review_json: JSON.stringify({
      author_name: 'James Thornton',
      text: 'Best cleaning service we have ever used in Sydney. The team arrived right on time and were incredibly thorough from top to bottom. They left our entire office absolutely spotless, including the kitchen and bathrooms. We have already booked them for weekly cleans going forward. Highly recommend ACME Cleaning to any business looking for reliable cleaners.',
      rating: 5,
    }),
  },
  {
    slug: 'plumber',
    id: 900003,
    business_name: 'ACME Plumbing',
    city: 'Sydney',
    niche: 'plumber',
    country_code: 'AU',
    best_review_author: 'Kate Williams',
    best_review_text: 'Called them for an emergency leak on a Sunday morning and they were here within the hour. The plumber was professional, friendly, and explained everything before starting work. Fixed the issue quickly with fair and transparent pricing. They even cleaned up after themselves which was a nice touch. Would not hesitate to call ACME Plumbing again for any future plumbing needs.',
    google_rating: 4.7,
    review_count: 256,
    phone: '0414 567 890',
    problem_category: 'blocked-drain',
    logo_url: null,
    selected_review_json: JSON.stringify({
      author_name: 'Kate Williams',
      text: 'Called them for an emergency leak on a Sunday morning and they were here within the hour. The plumber was professional, friendly, and explained everything before starting work. Fixed the issue quickly with fair and transparent pricing. They even cleaned up after themselves which was a nice touch. Would not hesitate to call ACME Plumbing again for any future plumbing needs.',
      rating: 5,
    }),
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const slugFilter = args.find(a => !a.startsWith('--'));

const sites = slugFilter
  ? DEMOS.filter(d => d.slug === slugFilter)
  : DEMOS;

if (sites.length === 0) {
  console.error(`Unknown slug: ${slugFilter}. Available: ${DEMOS.map(d => d.slug).join(', ')}`);
  process.exit(1);
}

// Insert temporary demo site rows if not present (FK constraint on videos table)
if (!dryRun) {
  const db = (await import('../src/utils/db.js')).default;
  const insertSite = db.prepare(`
    INSERT OR IGNORE INTO sites (id, business_name, city, niche, country_code,
      best_review_author, best_review_text, google_rating, review_count, phone,
      problem_category, logo_url, selected_review_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo')
  `);
  for (const site of sites) {
    insertSite.run(
      site.id, site.business_name, site.city, site.niche, site.country_code,
      site.best_review_author, site.best_review_text, site.google_rating,
      site.review_count, site.phone, site.problem_category, site.logo_url,
      site.selected_review_json,
    );
  }
}

console.log(`Rendering ${sites.length} demo video(s)${dryRun ? ' (DRY RUN)' : ''}...\n`);

for (const site of sites) {
  console.log(`=== ${site.business_name} (${site.slug}) ===`);

  if (dryRun) {
    const prospect = {
      business_name: site.business_name,
      city: site.city,
      niche: site.niche,
      best_review_author: site.best_review_author,
      best_review_text: site.best_review_text,
      google_rating: site.google_rating,
      phone: site.phone,
      logo_url: site.logo_url,
    };
    const scenes = buildScenes(prospect);
    const clips = pickClipsFromPool(site.problem_category || site.niche, site.id, site.best_review_text);
    console.log(`  Scenes: ${scenes.length}`);
    console.log(`  Clips: ${clips ? clips.length : 'NONE (missing pool)'}`);
    console.log(`  Review: "${site.best_review_text.slice(0, 60)}..."\n`);
    continue;
  }

  try {
    const result = await processSite(site, { dryRun: false });
    if (result) {
      console.log(`  Video URL:  ${result.videoUrl}`);
      console.log(`  Poster URL: ${result.posterUrl}`);
      console.log(`  Hash:       ${result.videoHash}`);
      console.log(`  Duration:   ${result.durationSeconds}s\n`);
    }
  } catch (err) {
    console.error(`  FAILED: ${err.message}\n`);
  }
}
