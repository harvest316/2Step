#!/usr/bin/env node

/**
 * Migration 010: Backfill video_id, video_url, video_hash on sites table.
 *
 * All 30 video_created sites have NULL video_id, video_url, video_hash because
 * they were created by the old standalone renderer (src/video/creatomate.js)
 * which only updated the videos table but not the sites table columns.
 *
 * Usage:
 *   node db/migrations/010-backfill-video-refs.js [--dry-run]
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const dbPath = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const dryRun = process.argv.includes('--dry-run');

// Base62 encoder (same as src/stages/video.js)
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function toBase62(num) {
  if (num === 0) return BASE62_CHARS[0];
  let result = '';
  let n = num;
  while (n > 0) {
    result = BASE62_CHARS[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// Find all video_created sites with missing video refs
const sites = db.prepare(`
  SELECT s.id, s.business_name, s.video_id, s.video_url, s.video_hash
  FROM sites s
  WHERE s.status = 'video_created'
    AND (s.video_id IS NULL OR s.video_url IS NULL OR s.video_hash IS NULL)
`).all();

if (sites.length === 0) {
  console.log('No sites need backfilling — all video_created sites already have video refs.');
  process.exit(0);
}

console.log(`Found ${sites.length} video_created site(s) needing backfill${dryRun ? ' (DRY RUN)' : ''}:\n`);

const updateSite = db.prepare(`
  UPDATE sites
  SET video_id   = ?,
      video_url  = ?,
      video_hash = ?,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getLatestVideo = db.prepare(`
  SELECT id, video_url, thumbnail_url
  FROM videos
  WHERE site_id = ? AND status = 'completed'
  ORDER BY created_at DESC
  LIMIT 1
`);

let updated = 0;
let skipped = 0;

const runAll = db.transaction(() => {
  for (const site of sites) {
    const video = getLatestVideo.get(site.id);

    if (!video) {
      console.log(`  [${site.id}] ${site.business_name} — SKIP (no completed video found)`);
      skipped++;
      continue;
    }

    const videoHash = toBase62(site.id);

    if (dryRun) {
      console.log(`  [${site.id}] ${site.business_name}`);
      console.log(`    video_id:   ${site.video_id ?? 'NULL'} → ${video.id}`);
      console.log(`    video_url:  ${site.video_url ?? 'NULL'} → ${video.video_url}`);
      console.log(`    video_hash: ${site.video_hash ?? 'NULL'} → ${videoHash}`);
    } else {
      updateSite.run(
        video.id,
        video.video_url,
        videoHash,
        site.id,
      );
      console.log(`  [${site.id}] ${site.business_name} → video_id=${video.id}, hash=${videoHash}`);
    }

    updated++;
  }
});

runAll();
db.close();

console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
