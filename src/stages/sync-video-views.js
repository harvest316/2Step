#!/usr/bin/env node

/**
 * sync-video-views — 2Step pipeline stage.
 *
 * Polls BRAND_URL/api.php?action=get-video-views to fetch view data for
 * all video pages, then writes video_viewed_at back to the local 2Step DB for
 * any site whose video has been viewed.
 *
 * Also flags sites that need a priority follow-up: if a video was viewed within
 * the last 30 minutes and the site has no followup1 sent yet, it marks
 * conversation_status='viewed_no_followup' so the outreach stage can prioritise
 * them.
 *
 * Architecture:
 *   - BRAND_URL/api.php stores views in data/videos/{hash}.json (per
 *     page load by the prospect's browser via the beacon in v.php)
 *   - get-video-views returns { videos: [{ hash, view_count, last_view }] }
 *   - We match by video_hash in the sites table
 *
 * Usage:
 *   node src/stages/sync-video-views.js            # Sync and update DB
 *   node src/stages/sync-video-views.js --dry-run  # Print changes, no DB writes
 *
 * Environment (loaded from 333Method/.env via load-env.js):
 *   BRAND_URL            — e.g. https://example.com
 *   API_WORKER_SECRET    — shared secret for X-Auth-Secret header
 */

import '../utils/load-env.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { getOne, run } from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const BRAND_URL          = (process.env.BRAND_URL || '').replace(/\/$/, '');
const WORKER_SECRET      = process.env.API_WORKER_SECRET || '';

// Priority follow-up window: flag sites viewed within this many minutes
const PRIORITY_WINDOW_MINUTES = 30;

// ── Fetch view data from Hostinger ───────────────────────────────────────────

/**
 * Fetch all video view records from the brand website API.
 * Returns an array of { hash, view_count, last_view } objects.
 *
 * @returns {Promise<Array<{ hash: string, view_count: number, last_view: string|null }>>}
 */
async function fetchVideoViews() {
  if (!WORKER_SECRET) {
    throw new Error(
      'API_WORKER_SECRET is not set — cannot authenticate with get-video-views endpoint'
    );
  }

  const url = `${BRAND_URL}/api.php?action=get-video-views`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Secret': WORKER_SECRET,
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`get-video-views returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.videos || [];
}

// ── Stage runner ─────────────────────────────────────────────────────────────

/**
 * Run the sync-video-views stage.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  Print changes without writing to DB
 * @returns {Promise<{ checked: number, updated: number, priorityFlagged: number, errors: number }>}
 */
export async function runSyncVideoViewsStage(options = {}) {
  const { dryRun = false } = options;

  console.log(`[sync-video-views] Fetching view data from ${BRAND_URL}${dryRun ? ' (DRY RUN)' : ''}...`);

  let videos;
  try {
    videos = await fetchVideoViews();
  } catch (err) {
    console.error(`[sync-video-views] Failed to fetch views: ${err.message}`);
    return { checked: 0, updated: 0, priorityFlagged: 0, errors: 1 };
  }

  const viewedVideos = videos.filter(v => v.view_count > 0 && v.last_view);
  console.log(`[sync-video-views] ${videos.length} video pages found, ${viewedVideos.length} with views`);

  if (viewedVideos.length === 0) {
    return { checked: videos.length, updated: 0, priorityFlagged: 0, errors: 0 };
  }

  const now = new Date();
  const priorityCutoff = new Date(now.getTime() - PRIORITY_WINDOW_MINUTES * 60 * 1000);

  let updated = 0;
  let priorityFlagged = 0;
  let errors = 0;

  for (const v of viewedVideos) {
    try {
      const site = await getOne(
        `SELECT id, business_name, video_viewed_at, followup1_sent_at, conversation_status
         FROM sites
         WHERE video_hash = $1
         LIMIT 1`,
        [v.hash]
      );

      if (!site) {
        // Hash exists on Hostinger but not in local DB — ignore (could be a test page)
        continue;
      }

      const lastViewDate = new Date(v.last_view);
      const lastViewIso  = lastViewDate.toISOString();

      // Determine if this is a new view (not yet recorded locally)
      const alreadyRecorded = site.video_viewed_at !== null;
      const isNewer = !alreadyRecorded ||
        new Date(site.video_viewed_at) < lastViewDate;

      if (isNewer) {
        if (dryRun) {
          console.log(
            `  [dry-run] Would set video_viewed_at=${lastViewIso} for site ${site.id} "${site.business_name}"`
          );
        } else {
          await run(
            `UPDATE sites
             SET video_viewed_at = $1,
                 updated_at      = NOW()
             WHERE id = $2
               AND (video_viewed_at IS NULL OR video_viewed_at < $3)`,
            [lastViewIso, site.id, lastViewIso]
          );
        }
        updated++;
      }

      // Flag for priority follow-up if: viewed recently AND no followup1 sent yet
      const viewedRecently = lastViewDate >= priorityCutoff;
      const noFollowup1    = !site.followup1_sent_at;

      if (viewedRecently && noFollowup1) {
        if (dryRun) {
          console.log(
            `  [dry-run] Would flag conversation_status=viewed_no_followup for site ${site.id} "${site.business_name}" (viewed ${v.last_view})`
          );
        } else {
          await run(
            `UPDATE sites
             SET conversation_status = 'viewed_no_followup',
                 updated_at          = NOW()
             WHERE id = $1
               AND (conversation_status IS NULL OR conversation_status NOT IN ('replied', 'closed', 'converted'))`,
            [site.id]
          );
        }
        priorityFlagged++;
      }
    } catch (err) {
      console.error(`  [error] hash=${v.hash}: ${err.message}`);
      errors++;
    }
  }

  console.log(
    `[sync-video-views] Done: ${viewedVideos.length} viewed, ` +
    `${updated} DB updated, ${priorityFlagged} priority-flagged, ${errors} errors`
  );

  return { checked: videos.length, updated, priorityFlagged, errors };
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });

  runSyncVideoViewsStage({ dryRun: args['dry-run'] })
    .then(result => {
      console.log('\nResult:', result);
      process.exit(result.errors > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('[sync-video-views] Fatal:', err.message);
      process.exit(1);
    });
}
