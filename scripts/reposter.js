#!/usr/bin/env node

/**
 * reposter — Re-extract poster frames from existing videos and re-push to Hostinger.
 *
 * Downloads each video from R2/CDN, extracts a clean frame from scene 0 midpoint,
 * uploads the new poster to R2, then re-pushes to api.php?action=store-video.
 *
 * Usage:
 *   node scripts/reposter.js              # All sites with a video_hash
 *   node scripts/reposter.js --id 5,7,9   # Specific site IDs only
 *   node scripts/reposter.js --dry-run    # Print plan, no changes
 */

import '../src/utils/load-env.js';
import { createWriteStream } from 'fs';
import { rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { parseArgs } from 'util';
import pg from 'pg';
import { buildPosterFromBuffer } from '../src/stages/video.js';
import { extractPosterFrame } from '../src/video/ffmpeg-render.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET     = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://cdn.auditandfix.com').replace(/\/$/, '');
const AUDITANDFIX_URL = (process.env.AUDITANDFIX_URL || 'https://auditandfix.com').replace(/\/$/, '');
const WORKER_SECRET = process.env.AUDITANDFIX_WORKER_SECRET || '';

const { values: args } = parseArgs({
  options: {
    id:        { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const dryRun = args['dry-run'];
const filterIds = args.id ? args.id.split(',').map(s => parseInt(s.trim(), 10)) : null;

// Scene 0 is the hook/intro clip — typically 3-5s. Transition is ~0.3s.
// Without re-rendering we don't have exact scene metadata, so use a conservative
// fixed time: 0.8s — well past the fade-in (usually 0-0.2s) but before any xfade out.
const POSTER_TIME = 0.8;

async function uploadBufferToR2(buffer, key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'image/jpeg' },
    body: buffer,
  });
  if (!res.ok) throw new Error(`R2 upload failed: ${res.status} ${await res.text()}`);
  return `${PUBLIC_URL}/${key}`;
}

async function downloadVideo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(destPath));
}

async function pushToApi(site, posterUrl) {
  const payload = {
    hash:          site.video_hash,
    video_url:     site.video_url,
    poster_url:    posterUrl,
    business_name: site.business_name,
    domain:        site.domain,
    review_count:  site.review_count,
    niche:         site.niche,
    country_code:  site.country_code,
  };
  const res = await fetch(`${AUDITANDFIX_URL}/api.php?action=store-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Auth-Secret': WORKER_SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`api.php failed: ${res.status} ${await res.text()}`);
}

async function main() {
  let query = `
    SELECT DISTINCT ON (s.id)
      s.id, s.video_hash, s.business_name, s.domain,
      s.video_url, s.niche, s.country_code, s.review_count
    FROM twostep.sites s
    JOIN twostep.videos v ON v.site_id = s.id
    WHERE s.video_hash IS NOT NULL AND s.video_url IS NOT NULL
    ORDER BY s.id, v.id DESC
  `;
  const { rows: sites } = await pool.query(query);
  const filtered = filterIds ? sites.filter(s => filterIds.includes(s.id)) : sites;

  console.log(`Reposter: ${filtered.length} site(s)${dryRun ? ' [dry-run]' : ''}`);

  let ok = 0, failed = 0;

  for (const site of filtered) {
    process.stdout.write(`[${site.id}] ${site.business_name}...`);

    if (dryRun) {
      console.log(` would extract t=${POSTER_TIME}s from ${site.video_url}`);
      ok++;
      continue;
    }

    const tmpVideo = join(tmpdir(), `reposter-s${site.id}-${Date.now()}.mp4`);
    try {
      // 1. Download video
      process.stdout.write(' download');
      await downloadVideo(site.video_url, tmpVideo);

      // 2. Extract frame
      process.stdout.write(' extract');
      const frame = await extractPosterFrame(tmpVideo, POSTER_TIME);

      // 3. Build poster (add play button overlay)
      process.stdout.write(' build');
      const posterBuf = await buildPosterFromBuffer(frame);

      // 4. Upload to R2
      process.stdout.write(' upload');
      const posterKey = `poster-s${site.id}-${Date.now()}.jpg`;
      const posterUrl = await uploadBufferToR2(posterBuf, posterKey);

      // 5. Push to api.php
      process.stdout.write(' push');
      await pushToApi(site, posterUrl);

      console.log(` done -> ${posterUrl}`);
      ok++;
    } catch (err) {
      console.log(` FAILED: ${err.message}`);
      failed++;
    } finally {
      await rm(tmpVideo, { force: true }).catch(() => {});
    }
  }

  await pool.end();
  console.log(`\nDone: ${ok} updated, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
