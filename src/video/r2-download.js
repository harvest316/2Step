#!/usr/bin/env node

/**
 * Download clips from R2 that aren't present locally.
 *
 * Reads all URLs from CLIP_POOLS and downloads any that don't exist under clips/.
 * Derives the local subdirectory from the filename prefix:
 *   shared-*         → clips/shared/
 *   cockroaches-*    → clips/pest-control/cockroaches/
 *   rodents-*        → clips/pest-control/rodents/
 *   spiders-*        → clips/pest-control/spiders/
 *   termites-*       → clips/pest-control/termites/
 *   blocked-drain-*  → clips/plumbing/blocked-drain/
 *   burst-pipe-*     → clips/plumbing/burst-pipe/
 *   leaking-tap-*    → clips/plumbing/leaking-tap/
 *   hot-water-*      → clips/plumbing/hot-water/
 *   greasy-rangehood-* → clips/house-cleaning/greasy-rangehood/
 *   dirty-bathroom-* → clips/house-cleaning/dirty-bathroom/
 *   deep-clean-*     → clips/house-cleaning/deep-clean/
 *   end-of-lease-*   → clips/house-cleaning/end-of-lease/
 *
 * Usage:
 *   node src/video/r2-download.js            # download all missing clips
 *   node src/video/r2-download.js --dry-run  # show what would be downloaded
 */

import { mkdirSync, createWriteStream, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { CLIP_POOLS } from './scene-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_ROOT = resolve(__dirname, '../../clips');

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  strict: false,
});

// ─── Filename → local subdirectory mapping ────────────────────────────────────

const PREFIX_TO_DIR = {
  'shared-':                  'shared',
  // Pest control
  'cockroaches-':             'pest-control/cockroaches',
  'rodents-':                 'pest-control/rodents',
  'spiders-':                 'pest-control/spiders',
  'termites-':                'pest-control/termites',
  // Plumbing shared + problem pools
  'plumbing-technician-':     'plumbing/shared',
  'plumbing-resolution-':     'plumbing/shared',
  'plumbing-cta-':            'plumbing/shared',
  'blocked-drain-':           'plumbing/blocked-drain',
  'burst-pipe-':              'plumbing/burst-pipe',
  'leaking-tap-':             'plumbing/leaking-tap',
  'hot-water-':               'plumbing/hot-water',
  // House cleaning shared + problem pools
  'house-cleaning-technician-': 'house-cleaning/shared',
  'house-cleaning-resolution-': 'house-cleaning/shared',
  'house-cleaning-cta-':        'house-cleaning/shared',
  'greasy-rangehood-':          'house-cleaning/greasy-rangehood',
  'dirty-bathroom-':            'house-cleaning/dirty-bathroom',
  'deep-clean-':                'house-cleaning/deep-clean',
  'end-of-lease-':              'house-cleaning/end-of-lease',
};

function localDir(filename) {
  for (const [prefix, dir] of Object.entries(PREFIX_TO_DIR)) {
    if (filename.startsWith(prefix)) return dir;
  }
  return 'misc'; // fallback
}

// ─── Collect all unique URLs from CLIP_POOLS ──────────────────────────────────

function collectUrls() {
  const seen = new Set();
  const results = [];
  for (const [, pool] of Object.entries(CLIP_POOLS)) {
    for (const [, clips] of Object.entries(pool)) {
      for (const clip of clips) {
        if (!seen.has(clip.url)) {
          seen.add(clip.url);
          results.push(clip.url);
        }
      }
    }
  }
  return results;
}

// ─── Download ─────────────────────────────────────────────────────────────────

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const dest = createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.body.pipeTo(new WritableStream({
      write(chunk) { dest.write(chunk); },
      close() { dest.end(); resolve(); },
      abort(err) { dest.destroy(); reject(err); },
    }));
  });
  return (dest.bytesWritten / 1024 / 1024).toFixed(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const urls = collectUrls();

  // Separate into already-local and missing
  const missing = [];
  for (const url of urls) {
    const filename = url.split('/').pop();
    const dir = localDir(filename);
    const destPath = resolve(CLIPS_ROOT, dir, filename);
    if (!existsSync(destPath)) missing.push({ url, filename, dir, destPath });
  }

  console.log(`\n${urls.length} clips in CLIP_POOLS — ${urls.length - missing.length} already local, ${missing.length} to download\n`);

  if (missing.length === 0) {
    console.log('Nothing to download.');
    return;
  }

  if (args['dry-run']) {
    for (const { filename, dir } of missing) {
      console.log(`  clips/${dir}/${filename}`);
    }
    return;
  }

  let ok = 0, fail = 0;
  for (const { url, filename, dir, destPath } of missing) {
    mkdirSync(resolve(CLIPS_ROOT, dir), { recursive: true });
    process.stdout.write(`  ${filename}...`);
    try {
      const mb = await download(url, destPath);
      console.log(` ${mb}MB ✓`);
      ok++;
    } catch (err) {
      console.log(` ✗  ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${ok} downloaded, ${fail} failed`);
  if (fail > 0) console.log('Failed clips may not exist in R2 yet — generate them first.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
