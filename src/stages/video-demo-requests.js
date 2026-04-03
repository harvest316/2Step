#!/usr/bin/env node

/**
 * Video demo requests pipeline stage.
 *
 * Polls the CF Worker /video-demos/pending endpoint for verified demo requests,
 * creates site records in the local DB, and processes them through the existing
 * video pipeline (reviews -> video).
 *
 * This stage bridges inbound VoD requests (from the landing page) into the
 * existing 2Step pipeline.
 *
 * Two phases per iteration:
 *   Phase A — Poll for new demo requests → INSERT into sites table
 *   Phase B — Complete ready demos → callback to CF Worker with video_url
 *
 * Usage:
 *   node src/stages/video-demo-requests.js              # Run once (default)
 *   node src/stages/video-demo-requests.js --dry-run    # Print plan, skip DB writes + callbacks
 *
 * Export:
 *   runVideoDemoRequestsStage(options?) → { polled, inserted, skipped, completed, errors }
 */

import '../utils/load-env.js';
import { getOne, getAll, run, query } from '../utils/db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const WORKER_URL    = process.env.API_WORKER_URL;
const WORKER_SECRET = process.env.API_WORKER_SECRET;

// ─── Worker HTTP helpers ─────────────────────────────────────────────────────

/**
 * Fetch pending demo requests from the CF Worker.
 * @returns {Promise<Array<Object>>} Array of pending demo objects
 */
async function fetchPendingDemos() {
  const url = `${WORKER_URL}/video-demos/pending`;
  const res = await fetch(url, {
    headers: {
      'X-Auth-Secret': WORKER_SECRET,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /video-demos/pending failed ${res.status}: ${text.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.demos ?? data.results ?? data ?? [];
}

/**
 * Notify the CF Worker that a demo video is ready (or delete the pending entry).
 * @param {string} kvKey   - KV key for the demo request
 * @param {string} videoUrl - Public URL of the completed video
 * @returns {Promise<void>}
 */
async function completeDemoCallback(kvKey, videoUrl) {
  const url = `${WORKER_URL}/video-demos/${encodeURIComponent(kvKey)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'X-Auth-Secret': WORKER_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ video_url: videoUrl, status: 'ready' }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE /video-demos/${kvKey} failed ${res.status}: ${text.substring(0, 300)}`);
  }
}

// ─── Phase A: Poll for new demo requests ─────────────────────────────────────

/**
 * Poll the CF Worker for pending demo requests and insert new sites.
 * @param {boolean} dryRun
 * @returns {Promise<{ polled: number, inserted: number, skipped: number, errors: number }>}
 */
async function phaseA(dryRun) {
  const stats = { polled: 0, inserted: 0, skipped: 0, errors: 0 };

  let demos;
  try {
    demos = await fetchPendingDemos();
  } catch (err) {
    console.error(`[video-demo-requests] Phase A fetch failed: ${err.message}`);
    stats.errors++;
    return stats;
  }

  stats.polled = demos.length;

  if (demos.length === 0) {
    console.log('[video-demo-requests] Phase A: no pending demos');
    return stats;
  }

  console.log(`[video-demo-requests] Phase A: ${demos.length} pending demo(s)`);

  for (const demo of demos) {
    const placeId      = demo.place_id;
    const businessName = demo.business_name || '(unknown)';
    const kvKey        = demo.kv_key || demo.key;

    if (!placeId) {
      console.warn(`[video-demo-requests]   Skip (no place_id): ${businessName}`);
      stats.skipped++;
      continue;
    }

    // Check if already exists
    const existing = await getOne(
      "SELECT id FROM sites WHERE google_place_id = $1 AND source = 'demo_request'",
      [placeId]
    );
    if (existing) {
      console.log(`[video-demo-requests]   Skip (already processing, site ${existing.id}): ${businessName}`);
      stats.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[video-demo-requests]   [DRY RUN] Would insert: ${businessName} (${demo.niche || 'unknown niche'})`);
      stats.inserted++;
      continue;
    }

    try {
      await run(
        `INSERT INTO sites (
          business_name, niche, city, country_code,
          google_place_id, status, source, demo_kv_key, manual_fulfillment
        ) VALUES (
          $1, $2, $3, $4,
          $5, 'found', 'demo_request', $6, $7
        )`,
        [
          businessName,
          demo.niche || null,
          demo.city || null,
          demo.country_code || null,
          placeId,
          kvKey,
          demo.manual_fulfillment ? true : false,
        ]
      );
      console.log(`[video-demo-requests]   Inserted: ${businessName} (kv=${kvKey})`);
      stats.inserted++;
    } catch (err) {
      console.error(`[video-demo-requests]   Insert failed for "${businessName}": ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

// ─── Phase B: Complete ready demos ───────────────────────────────────────────

/**
 * Find completed demo sites and callback to the CF Worker.
 * @param {boolean} dryRun
 * @returns {Promise<{ completed: number, errors: number }>}
 */
async function phaseB(dryRun) {
  const stats = { completed: 0, errors: 0 };

  const readySites = await getAll(
    `SELECT id, business_name, video_url, demo_kv_key
     FROM sites
     WHERE source = 'demo_request'
       AND (status = 'video_created' OR video_url IS NOT NULL)
       AND demo_kv_key IS NOT NULL`
  );

  if (readySites.length === 0) {
    console.log('[video-demo-requests] Phase B: no ready demos to complete');
    return stats;
  }

  console.log(`[video-demo-requests] Phase B: ${readySites.length} demo(s) ready for callback`);

  for (const site of readySites) {
    if (dryRun) {
      console.log(`[video-demo-requests]   [DRY RUN] Would complete: site ${site.id} "${site.business_name}" -> ${site.video_url}`);
      stats.completed++;
      continue;
    }

    try {
      await completeDemoCallback(site.demo_kv_key, site.video_url);
      await run(
        `UPDATE sites SET demo_kv_key = NULL, updated_at = NOW() WHERE id = $1`,
        [site.id]
      );
      console.log(`[video-demo-requests]   Completed: site ${site.id} "${site.business_name}" (kv=${site.demo_kv_key})`);
      stats.completed++;
    } catch (err) {
      console.error(`[video-demo-requests]   Callback failed for site ${site.id}: ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

// ─── Exported stage function ─────────────────────────────────────────────────

/**
 * Run the video demo requests stage.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]  Skip DB writes and CF Worker callbacks
 * @returns {Promise<{ polled: number, inserted: number, skipped: number, completed: number, errors: number }>}
 */
export async function runVideoDemoRequestsStage(options = {}) {
  const dryRun = options.dryRun ?? false;

  // Guard: skip silently if worker config is not set
  if (!WORKER_URL || !WORKER_SECRET) {
    console.log('[video-demo-requests] API_WORKER_URL or API_WORKER_SECRET not set — skipping');
    return { polled: 0, inserted: 0, skipped: 0, completed: 0, errors: 0 };
  }

  console.log(`[video-demo-requests] Starting${dryRun ? ' [dry-run]' : ''}...`);

  // Phase A — poll for new requests
  const a = await phaseA(dryRun);

  // Phase B — complete ready demos
  const b = await phaseB(dryRun);

  const result = {
    polled:    a.polled,
    inserted:  a.inserted,
    skipped:   a.skipped,
    completed: b.completed,
    errors:    a.errors + b.errors,
  };

  console.log('[video-demo-requests] Stage complete:', result);
  return result;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });

  runVideoDemoRequestsStage({
    dryRun: args['dry-run'],
  }).catch(err => {
    console.error('[video-demo-requests] Fatal:', err.message);
    process.exit(1);
  });
}
