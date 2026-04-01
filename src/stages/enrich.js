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
import { getOne, getAll, run, getPool } from '../utils/db.js';
import { runEnrichmentStage } from '../../../333Method/src/stages/enrich.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const HTML_DIR = resolve(ROOT, 'data/html');

// R2 upload config (same as r2-upload.js)
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET     = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

// Logo treatment constants
const PILL_MAX_W = 972;
const PILL_MAX_H = 480;
const PILL_RADIUS = 12;   // rounded rectangle (was 24 for lozenge)
const PILL_PADDING = 24;  // padding around logo inside the pill

/**
 * Upload a Buffer to R2 and return the public URL.
 * @param {Buffer} body - Image bytes
 * @param {string} key - R2 object key (e.g. "logos/123-grey.png")
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} Public URL
 */
/* c8 ignore start — R2 upload + logo fetch + enrichment delegation I/O */
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

/* c8 ignore stop */

/**
 * Detect whether a logo has a solid-colour background by sampling border pixels.
 * Returns { hasSolidBg, isLight, bgColor } where bgColor is {r,g,b}.
 *
 * @param {Buffer} imgBuf - PNG/JPEG bytes
 * @returns {Promise<{ hasSolidBg: boolean, isLight: boolean, hasAlpha: boolean, bgColor: {r:number,g:number,b:number} }>}
 */
async function detectLogoBg(imgBuf) {
  const meta = await sharp(imgBuf).metadata();
  const w = meta.width || 100;
  const h = meta.height || 100;
  const hasAlpha = meta.channels === 4 || meta.hasAlpha;

  // Extract raw RGBA pixels
  const { data } = await sharp(imgBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // Sample border pixels (top row, bottom row, left col, right col)
  const samples = [];
  for (let x = 0; x < w; x++) {
    samples.push((0 * w + x) * 4);         // top row
    samples.push(((h - 1) * w + x) * 4);   // bottom row
  }
  for (let y = 1; y < h - 1; y++) {
    samples.push((y * w + 0) * 4);         // left col
    samples.push((y * w + (w - 1)) * 4);   // right col
  }

  // Check if most border pixels are transparent
  let transparentCount = 0;
  for (const i of samples) {
    if (data[i + 3] < 32) transparentCount++;
  }
  if (transparentCount / samples.length > 0.7) {
    // Logo has a transparent background — analyse content colour using OPAQUE pixels only.
    // Do NOT use sharp.stats() here: transparent pixels are often stored with their original
    // background colour (commonly white), which wildly inflates the mean and causes incorrect
    // isLight detection. We must only average pixels where alpha > 32.
    let lightPx = 0, darkPx = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 32) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        lum > 160 ? lightPx++ : darkPx++;
      }
    }
    // If no opaque pixels at all, fall back to light (treat as light content on transparent)
    const isLight = (lightPx + darkPx) === 0 ? true : lightPx > darkPx;
    return { hasSolidBg: false, isLight, hasAlpha: true, bgColor: { r: 0, g: 0, b: 0 } };
  }

  // Check colour consistency of border pixels
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (const i of samples) {
    if (data[i + 3] > 200) { // only opaque pixels
      sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2];
      count++;
    }
  }
  if (count < samples.length * 0.5) {
    // Not enough opaque border pixels — treat as transparent.
    // Use opaque-pixel-only luminance (same reason as above: stats() includes transparent
    // pixels whose stored colour pollutes the mean).
    let lightPx = 0, darkPx = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 32) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        lum > 160 ? lightPx++ : darkPx++;
      }
    }
    const isLight2 = (lightPx + darkPx) === 0 ? true : lightPx > darkPx;
    return { hasSolidBg: false, isLight: isLight2, hasAlpha, bgColor: { r: 0, g: 0, b: 0 } };
  }

  const avgR = Math.round(sumR / count);
  const avgG = Math.round(sumG / count);
  const avgB = Math.round(sumB / count);

  // Check if border pixels are consistent (low variance = solid background)
  let variance = 0;
  for (const i of samples) {
    if (data[i + 3] > 200) {
      variance += (data[i] - avgR) ** 2 + (data[i + 1] - avgG) ** 2 + (data[i + 2] - avgB) ** 2;
    }
  }
  variance /= (count * 3);
  const hasSolidBg = variance < 400; // low variance = consistent colour

  const luminance = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;
  return { hasSolidBg, isLight: luminance > 160, hasAlpha, bgColor: { r: avgR, g: avgG, b: avgB } };
}

/**
 * Apply adaptive background treatment to a logo image.
 *
 * Detection logic:
 *   - Solid white/light background → extend into a white padded rectangle
 *   - Solid dark background → extend into a dark padded rectangle
 *   - Transparent + light logo → dark (navy) rectangle background
 *   - Transparent + dark logo → white rectangle background
 *   - Unknown/mixed → semi-transparent white rectangle (neutral fallback)
 *
 * @param {Buffer} imgBuf - Original logo image bytes
 * @returns {Promise<Buffer>} Treated PNG bytes
 */
async function applyGreyPill(imgBuf) {
  const bg = await detectLogoBg(imgBuf);

  // Decide background colour
  let pillR, pillG, pillB, pillA;
  if (bg.hasSolidBg) {
    if (bg.isLight) {
      // White/light solid background — extend with white
      pillR = 255; pillG = 255; pillB = 255; pillA = 230;
    } else {
      // Dark solid background — extend with dark
      pillR = bg.bgColor.r; pillG = bg.bgColor.g; pillB = bg.bgColor.b; pillA = 230;
    }
  } else if (bg.hasAlpha) {
    if (bg.isLight) {
      // Transparent logo with light content → dark background for contrast
      pillR = 26; pillG = 54; pillB = 93; pillA = 200; // navy
    } else {
      // Transparent logo with dark content → white background
      pillR = 255; pillG = 255; pillB = 255; pillA = 230;
    }
  } else {
    // Fallback: semi-transparent white
    pillR = 255; pillG = 255; pillB = 255; pillA = 180;
  }

  // Resize logo to fit within max bounds (with room for padding)
  const innerMaxW = PILL_MAX_W - PILL_PADDING * 2;
  const innerMaxH = PILL_MAX_H - PILL_PADDING * 2;

  const resizedLogo = await sharp(imgBuf)
    .resize(innerMaxW, innerMaxH, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const logoMeta = await sharp(resizedLogo).metadata();
  const logoW = logoMeta.width;
  const logoH = logoMeta.height;

  // Pill dimensions = logo + padding
  const pillW = logoW + PILL_PADDING * 2;
  const pillH = logoH + PILL_PADDING * 2;

  // Build rounded-rectangle SVG background
  const pillSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="${pillH}">` +
    `<rect width="${pillW}" height="${pillH}" rx="${PILL_RADIUS}" ry="${PILL_RADIUS}" ` +
    `fill="rgba(${pillR},${pillG},${pillB},${(pillA / 255).toFixed(3)})"/>` +
    `</svg>`
  );

  // Composite: background rect, then logo centred with padding
  const result = await sharp({
    create: {
      width: pillW,
      height: pillH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: pillSvg,     top: 0,            left: 0 },
      { input: resizedLogo, top: PILL_PADDING, left: PILL_PADDING },
    ])
    .png()
    .toBuffer();

  return result;
}

/* c8 ignore start — logo processing with network + R2 I/O */
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

  // Include a timestamp in the key so each re-treatment gets a unique URL.
  // Overwriting the same key hits CDN cache and the old version is baked into
  // any video rendered against it — always use a fresh key.
  const key = `logos/${site.id}-grey-${Date.now()}.png`;

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

  await run(
    'UPDATE sites SET logo_url = $1, updated_at = NOW() WHERE id = $2',
    [r2Url, site.id]
  );

  console.log(`  [${site.id}] Logo treated -> ${r2Url}`);
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
  const sites = await getAll(
    `SELECT id, business_name, logo_url, contacts_json, screenshot_path, status
     FROM sites
     WHERE status = 'reviews_downloaded'
     ORDER BY id
     ${limitClause}`
  );

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
      db: { getPool },
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
  const placeholders = siteIds.map((_, i) => `$${i + 1}`).join(',');
  const enrichedSites = await getAll(
    `SELECT id, business_name, logo_url FROM sites WHERE id IN (${placeholders})`,
    siteIds
  );

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
    const current = await getOne(
      'SELECT status, error_message FROM sites WHERE id = $1',
      [site.id]
    );

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
      await run(
        `UPDATE sites
         SET status = 'enriched', updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('ignored', 'enriched')`,
        [site.id]
      );
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

/* c8 ignore stop */

// ── Test-visible exports for pure helper functions ───────────────────────

export {
  applyGreyPill,
  detectLogoBg,
  PILL_MAX_W, PILL_MAX_H, PILL_RADIUS, PILL_PADDING,
};

// ── CLI entry point ──────────────────────────────────────────────────────────

/* c8 ignore start — CLI entry point */
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
/* c8 ignore stop */
