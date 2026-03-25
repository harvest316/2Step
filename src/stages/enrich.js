#!/usr/bin/env node

/**
 * Enrichment pipeline stage for 2Step.
 *
 * Takes sites at status='reviews_downloaded' and:
 *   1. Calls 333Method's runEnrichmentStage() with injected DB + statusFilter
 *   2. Applies grey-pill logo treatment via sharp (rounded rect, #808080 @ ~50%, max 972x480)
 *   3. Uploads treated logo to R2
 *   4. Extracts contacts from cached HTML pages in data/html/
 *   5. Advances sites to status='enriched'
 *
 * Usage:
 *   node src/stages/enrich.js
 *   node src/stages/enrich.js --limit 5
 *   node src/stages/enrich.js --limit 5 --concurrency 3 --dry-run
 */

import '../utils/load-env.js';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import sharp from 'sharp';
import db from '../utils/db.js';
import { runEnrichmentStage } from '../../../333Method/src/stages/enrich.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const HTML_DIR = resolve(ROOT, 'data/html');

// R2 upload config (same as r2-upload.js)
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET     = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

// Grey-pill treatment constants
const PILL_MAX_W = 972;
const PILL_MAX_H = 480;
const PILL_RADIUS = 24;
// #808080 at ~50% opacity = rgba(128,128,128,128)
const PILL_BG_R = 128;
const PILL_BG_G = 128;
const PILL_BG_B = 128;
const PILL_BG_A = 128;

/**
 * Upload a Buffer to R2 and return the public URL.
 * @param {Buffer} body - Image bytes
 * @param {string} key - R2 object key (e.g. "logos/123-grey.png")
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} Public URL
 */
async function uploadToR2(body, key, contentType = 'image/png') {
  if (!ACCOUNT_ID || !API_TOKEN || !BUCKET) {
    throw new Error(
      'R2 upload requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and R2_BUCKET_NAME'
    );
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': contentType,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed ${res.status}: ${text.substring(0, 200)}`);
  }
  return `${PUBLIC_URL}/${key}`;
}

/**
 * Fetch a logo image from a URL and return it as a Buffer.
 * @param {string} logoUrl
 * @returns {Promise<Buffer>}
 */
async function fetchLogo(logoUrl) {
  const res = await fetch(logoUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 2step-enrich/1.0)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch logo (${res.status}): ${logoUrl}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Apply grey-pill treatment to a logo image.
 *
 * - Constrains to PILL_MAX_W x PILL_MAX_H (never upscales)
 * - Composites a semi-transparent middle-grey (#808080 @ ~50%) rounded rectangle behind the logo
 * - Returns a PNG Buffer
 *
 * @param {Buffer} imgBuf - Original logo image bytes
 * @returns {Promise<Buffer>} Treated PNG bytes
 */
async function applyGreyPill(imgBuf) {
  // Load and get metadata
  const image = sharp(imgBuf);
  const meta = await image.metadata();

  // Compute display dimensions — shrink to fit, never upscale
  const srcW = meta.width || PILL_MAX_W;
  const srcH = meta.height || PILL_MAX_H;
  const scaleW = Math.min(1, PILL_MAX_W / srcW);
  const scaleH = Math.min(1, PILL_MAX_H / srcH);
  const scale = Math.min(scaleW, scaleH);
  const dispW = Math.round(srcW * scale);
  const dispH = Math.round(srcH * scale);

  // Resize logo (never upscale)
  const resizedLogo = await sharp(imgBuf)
    .resize(dispW, dispH, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  // Build rounded-rectangle SVG for the pill background
  // Pill fills the entire display size — logo is composited on top
  const pillSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}">` +
    `<rect width="${dispW}" height="${dispH}" rx="${PILL_RADIUS}" ry="${PILL_RADIUS}" ` +
    `fill="rgba(${PILL_BG_R},${PILL_BG_G},${PILL_BG_B},${(PILL_BG_A / 255).toFixed(3)})"/>` +
    `</svg>`
  );

  // Composite: grey pill background, then logo on top (both centred, same size)
  const result = await sharp({
    create: {
      width: dispW,
      height: dispH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: pillSvg,     top: 0, left: 0 },
      { input: resizedLogo, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();

  return result;
}

/**
 * Process the grey-pill treatment for one site.
 *
 * Fetches logo_url, applies treatment, uploads to R2, updates logo_url in DB.
 * Returns the new R2 URL, or null if skipped/failed.
 *
 * @param {Object} site - { id, logo_url, business_name }
 * @param {boolean} dryRun
 * @returns {Promise<string|null>}
 */
async function processLogoPill(site, dryRun) {
  if (!site.logo_url) {
    console.log(`  [${site.id}] No logo_url — skipping grey-pill`);
    return null;
  }

  let imgBuf;
  try {
    imgBuf = await fetchLogo(site.logo_url);
  } catch (err) {
    console.warn(`  [${site.id}] Logo fetch failed: ${err.message}`);
    return null;
  }

  let treatedBuf;
  try {
    treatedBuf = await applyGreyPill(imgBuf);
  } catch (err) {
    console.warn(`  [${site.id}] Grey-pill treatment failed: ${err.message}`);
    return null;
  }

  const key = `logos/${site.id}-grey.png`;

  if (dryRun) {
    console.log(`  [${site.id}] DRY RUN — would upload to R2: ${key} (${treatedBuf.length} bytes)`);
    return `${PUBLIC_URL || 'https://r2.example.com'}/${key}`;
  }

  let r2Url;
  try {
    r2Url = await uploadToR2(treatedBuf, key, 'image/png');
  } catch (err) {
    console.warn(`  [${site.id}] R2 upload failed: ${err.message}`);
    return null;
  }

  db.prepare('UPDATE sites SET logo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(r2Url, site.id);

  console.log(`  [${site.id}] Logo treated → ${r2Url}`);
  return r2Url;
}

/**
 * Ensure data/html/ directory exists.
 */
function ensureHtmlDir() {
  if (!existsSync(HTML_DIR)) {
    mkdirSync(HTML_DIR, { recursive: true });
  }
}

/**
 * Run the 2Step enrichment stage.
 *
 * @param {Object} options
 * @param {number} [options.limit]       - Max sites to process
 * @param {number} [options.concurrency] - Parallel browser sessions (default: 3)
 * @param {boolean} [options.dryRun]     - Skip DB writes and R2 uploads
 * @returns {Promise<{ processed: number, enriched: number, errors: number }>}
 */
export async function runEnrichStage(options = {}) {
  const { limit, concurrency = 3, dryRun = false } = options;

  ensureHtmlDir();

  console.log(
    `[enrich] Starting 2Step enrichment stage` +
    ` (limit=${limit ?? 'all'}, concurrency=${concurrency}${dryRun ? ', DRY RUN' : ''})`
  );

  // Query sites at reviews_downloaded
  const limitClause = limit ? `LIMIT ${parseInt(limit, 10)}` : '';
  const sites = db
    .prepare(
      `SELECT id, business_name, logo_url, contacts_json, screenshot_path, status
       FROM sites
       WHERE status = 'reviews_downloaded'
       ORDER BY id
       ${limitClause}`
    )
    .all();

  if (sites.length === 0) {
    console.log('[enrich] No sites at reviews_downloaded — nothing to do');
    return { processed: 0, enriched: 0, errors: 0 };
  }

  console.log(`[enrich] Found ${sites.length} site(s) at reviews_downloaded`);

  // ── Step 1: Run 333Method enrichment (browser browse + contact extraction) ──
  // We inject our db connection and override the status filter so it picks up
  // reviews_downloaded sites rather than the default scored statuses.
  console.log('[enrich] Step 1: running 333Method enrichment (contact extraction)...');

  let enrichStats = { processed: 0, succeeded: 0, failed: 0 };
  try {
    enrichStats = await runEnrichmentStage({
      db,
      statusFilter: 'reviews_downloaded',
      limit,
      concurrency,
    });
    console.log(
      `[enrich] 333Method enrichment complete: ` +
      `${enrichStats.succeeded ?? 0} succeeded, ${enrichStats.failed ?? 0} failed`
    );
  } catch (err) {
    console.error(`[enrich] 333Method enrichment threw: ${err.message}`);
    // Continue — logo treatment and status update are still worth doing for
    // any sites that were enriched before the error
  }

  // ── Step 2: Grey-pill logo treatment + R2 upload ──
  // Re-query to get current logo_url values (may have been populated by enrichment above)
  const siteIds = sites.map(s => s.id);
  const placeholders = siteIds.map(() => '?').join(',');
  const enrichedSites = db
    .prepare(
      `SELECT id, business_name, logo_url FROM sites WHERE id IN (${placeholders})`
    )
    .all(...siteIds);

  console.log(`[enrich] Step 2: grey-pill logo treatment for ${enrichedSites.length} site(s)...`);

  let logosProcessed = 0;
  let logosFailed = 0;

  for (const site of enrichedSites) {
    try {
      const result = await processLogoPill(site, dryRun);
      if (result !== null) logosProcessed++;
    } catch (err) {
      console.warn(`  [${site.id}] Logo processing error: ${err.message}`);
      logosFailed++;
    }
  }

  console.log(`[enrich] Logo treatment: ${logosProcessed} treated, ${logosFailed} failed`);

  // ── Step 3: Advance status to 'enriched' ──
  // 333Method's enrichment sets status to 'enriched_regex' or leaves the site
  // at the input status if it failed. We advance any site that moved away from
  // 'reviews_downloaded' to our own 'enriched' terminal status.
  //
  // Sites still at 'reviews_downloaded' after enrichment had errors — leave
  // them for retry rather than force-advancing.

  let enrichedCount = 0;
  let errorCount = 0;

  for (const site of sites) {
    const current = db
      .prepare('SELECT status, error_message FROM sites WHERE id = ?')
      .get(site.id);

    if (!current) continue;

    if (current.status === 'reviews_downloaded') {
      // Still at input status — enrichment did not complete for this site
      errorCount++;
      console.log(
        `  [${site.id}] ${site.business_name}: still at reviews_downloaded after enrichment` +
        (current.error_message ? ` — ${current.error_message}` : '')
      );
      continue;
    }

    // Enrichment moved it forward (enriched_regex, enriched_llm, enriched, or ignored)
    if (!dryRun) {
      db.prepare(
        `UPDATE sites
         SET status = 'enriched', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status NOT IN ('ignored', 'enriched')`
      ).run(site.id);
    }

    enrichedCount++;
    console.log(`  [${site.id}] ${site.business_name}: enriched`);
  }

  const summary = {
    processed: sites.length,
    enriched: enrichedCount,
    errors: errorCount,
  };

  console.log(
    `[enrich] Stage complete: ` +
    `${summary.processed} processed, ` +
    `${summary.enriched} enriched, ` +
    `${summary.errors} errors`
  );

  return summary;
}

// ── Test-visible exports for pure helper functions ───────────────────────

export {
  applyGreyPill,
  PILL_MAX_W, PILL_MAX_H, PILL_RADIUS,
  PILL_BG_R, PILL_BG_G, PILL_BG_B, PILL_BG_A,
};

// ── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values: args } = parseArgs({
    options: {
      limit:       { type: 'string' },
      concurrency: { type: 'string' },
      'dry-run':   { type: 'boolean', default: false },
    },
    strict: false,
  });

  runEnrichStage({
    limit:       args.limit       ? parseInt(args.limit, 10) : undefined,
    concurrency: args.concurrency ? parseInt(args.concurrency, 10) : 3,
    dryRun:      args['dry-run'],
  })
    .then(stats => {
      console.log('\nDone:', stats);
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
