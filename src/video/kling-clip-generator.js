#!/usr/bin/env node

/**
 * Kling AI clip generator — generates portrait MP4 clips via Kling API
 * and uploads them to Cloudflare R2 for use in CLIP_POOLS.
 *
 * Each generated clip is tracked with source: 'kling' so clips can be
 * audited or bulk-removed if Kling's licence terms change.
 *
 * Usage:
 *   node src/video/kling-clip-generator.js --prompt "pest control technician spraying kitchen" --slot hook --niche "pest control"
 *   node src/video/kling-clip-generator.js --list                  # list all kling clips in pool
 *   node src/video/kling-clip-generator.js --remove-all-kling      # print removal instructions
 *
 * Kling API docs: https://klingai.com/api/docs
 * Model: kling-v1-6  (best quality, 9:16 portrait, 5s default)
 */

import '../utils/load-env.js';
import { createHmac } from 'crypto';
import { parseArgs } from 'util';
import { clipsBySource } from './shotstack-lib.js';

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const KLING_API_BASE   = 'https://api.klingai.com/v1';

/**
 * Generate a short-lived HS256 JWT for Kling API auth.
 * Kling requires: { iss: accessKey, exp: now+1800, nbf: now-5 }
 */
function klingJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 })).toString('base64url');
  const sig = createHmac('sha256', KLING_SECRET_KEY).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// Duration in seconds — 5s clips keep render costs low
const CLIP_DURATION    = 5;
const CLIP_ASPECT      = '9:16';
const KLING_MODEL      = 'kling-v1-6';

const { values: args } = parseArgs({
  options: {
    prompt:            { type: 'string' },
    slot:              { type: 'string' },   // hook | technician | treatment | resolution | cta
    niche:             { type: 'string', default: 'pest control' },
    list:              { type: 'boolean', default: false },
    'remove-all-kling':{ type: 'boolean', default: false },
    'dry-run':         { type: 'boolean', default: false },
  },
  strict: false,
});

// ─── Kling API ────────────────────────────────────────────────────────────────

async function submitKlingGeneration(prompt) {
  const res = await fetch(`${KLING_API_BASE}/videos/text2video`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${klingJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_name:    KLING_MODEL,
      prompt,
      duration:      String(CLIP_DURATION),
      aspect_ratio:  CLIP_ASPECT,
      mode:          'std',   // std = standard quality; pro costs 2x
      cfg_scale:     0.5,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kling submit failed ${res.status}: ${body.substring(0, 300)}`);
  }

  const data = await res.json();
  // Kling returns task ID in data.data.task_id
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error(`Kling response missing task_id: ${JSON.stringify(data)}`);
  return taskId;
}

async function pollKlingTask(taskId, maxWaitMs = 300000) {
  const start = Date.now();
  process.stdout.write('  Generating clip');

  while (Date.now() - start < maxWaitMs) {
    await sleep(5000);
    const res = await fetch(`${KLING_API_BASE}/videos/text2video/${taskId}`, {
      headers: { 'Authorization': `Bearer ${klingJwt()}` },
    });

    if (!res.ok) throw new Error(`Kling poll failed ${res.status}`);
    const data = await res.json();
    const task = data?.data;
    const status = task?.task_status;

    if (status === 'succeed') {
      process.stdout.write(' ✓\n');
      // URL is in works[0].resource_list[0].resource (mp4 url)
      const url = task?.task_result?.videos?.[0]?.url;
      if (!url) throw new Error(`Kling task succeeded but no video URL: ${JSON.stringify(task)}`);
      return url;
    }

    if (status === 'failed') {
      process.stdout.write(' ✗\n');
      throw new Error(`Kling generation failed: ${task?.task_status_msg || 'unknown'}`);
    }

    process.stdout.write('.');
  }

  throw new Error(`Kling generation timed out after ${maxWaitMs / 1000}s`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function printClipEntry(niche, slot, url) {
  console.log('\n  ─── Add this to CLIP_POOLS in shotstack-lib.js ───');
  console.log(`  Niche: "${niche}"  Slot: "${slot}"`);
  console.log(`  { url: '${url}', source: 'kling' }`);
  console.log('  ──────────────────────────────────────────────────\n');
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function listKlingClips() {
  const clips = clipsBySource('kling');
  if (!clips.length) {
    console.log('No kling clips currently in CLIP_POOLS.');
    return;
  }
  console.log(`\n${clips.length} kling clip(s) in CLIP_POOLS:\n`);
  for (const c of clips) {
    console.log(`  [${c.niche}] ${c.slot}: ${c.url}`);
  }
  console.log();
}

function printRemoveInstructions() {
  const clips = clipsBySource('kling');
  if (!clips.length) {
    console.log('No kling clips to remove.');
    return;
  }
  console.log(`\nTo remove all ${clips.length} kling clip(s), delete these entries from CLIP_POOLS in src/video/shotstack-lib.js:\n`);
  for (const c of clips) {
    console.log(`  [${c.niche}] ${c.slot}: ${c.url}`);
  }
  console.log('\nThen run: node src/video/kling-clip-generator.js --list  to confirm removal.\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (args.list) {
    listKlingClips();
    return;
  }

  if (args['remove-all-kling']) {
    printRemoveInstructions();
    return;
  }

  if (!args.prompt || !args.slot) {
    console.error('Usage: node src/video/kling-clip-generator.js --prompt "..." --slot <hook|technician|treatment|resolution|cta> [--niche "pest control"]');
    console.error('       node src/video/kling-clip-generator.js --list');
    process.exit(1);
  }

  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  const validSlots = ['hook', 'technician', 'treatment', 'resolution', 'cta'];
  if (!validSlots.includes(args.slot)) {
    console.error(`ERROR: --slot must be one of: ${validSlots.join(', ')}`);
    process.exit(1);
  }

  console.log(`\nGenerating Kling clip`);
  console.log(`  Prompt: "${args.prompt}"`);
  console.log(`  Niche:  ${args.niche}  Slot: ${args.slot}`);
  console.log(`  Model:  ${KLING_MODEL}  ${CLIP_DURATION}s  ${CLIP_ASPECT}`);

  if (args['dry-run']) {
    console.log('\n  [DRY RUN] Would submit to Kling API — skipping.');
    printClipEntry(args.niche, args.slot, 'https://example.com/dry-run-clip.mp4');
    return;
  }

  const taskId = await submitKlingGeneration(args.prompt);
  console.log(`  Task ID: ${taskId}`);

  const videoUrl = await pollKlingTask(taskId);
  console.log(`  Kling URL: ${videoUrl}`);

  printClipEntry(args.niche, args.slot, videoUrl);

  console.log('Note: Kling URLs may expire. Host on R2/S3 for permanent use.');
  console.log('      Download with: curl -o clip.mp4 "' + videoUrl + '"');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
