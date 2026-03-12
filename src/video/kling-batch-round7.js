#!/usr/bin/env node

/**
 * Round 7 — Regenerate 3 deleted clips.
 *
 * Clips deleted by user after review (didn't meet quality bar):
 *   leaking-tap-treatment-b  — plumber fixing dripping tap
 *   deep-clean-hook-c        — grimy home close-ups
 *   deep-clean-treatment-c   — deep clean skirting boards / behind appliances
 *
 * Using refined prompts to get cleaner, more on-topic results.
 * 3 clips × 8 credits = 24 credits.
 *
 * Usage:
 *   node src/video/kling-batch-round7.js
 *   node src/video/kling-batch-round7.js --dry-run
 */

import '../utils/load-env.js';
import { createHmac } from 'crypto';
import { mkdirSync, createWriteStream, existsSync } from 'fs';
import { parseArgs } from 'util';
import path from 'path';

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const KLING_API_BASE   = 'https://api.klingai.com/v1';
const CLIPS_ROOT       = new URL('../../clips', import.meta.url).pathname;

const CREDITS_PER_CLIP = 8;
const CREDIT_FLOOR     = 200;

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  strict: false,
});

function klingJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 })).toString('base64url');
  const sig = createHmac('sha256', KLING_SECRET_KEY).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function submit(prompt) {
  const res = await fetch(`${KLING_API_BASE}/videos/text2video`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${klingJwt()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_name: 'kling-v3', prompt, duration: '5', aspect_ratio: '9:16', mode: 'pro', cfg_scale: 0.7 }),
  });
  if (!res.ok) throw new Error(`submit failed ${res.status}: ${(await res.text()).substring(0, 200)}`);
  const data = await res.json();
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error(`missing task_id: ${JSON.stringify(data)}`);
  return taskId;
}

async function pollOne(taskId) {
  const res = await fetch(`${KLING_API_BASE}/videos/text2video/${taskId}`, {
    headers: { 'Authorization': `Bearer ${klingJwt()}` },
  });
  if (!res.ok) throw new Error(`poll failed ${res.status}`);
  const data = await res.json();
  const task = data?.data;
  return { status: task?.task_status, url: task?.task_result?.videos?.[0]?.url };
}

async function pollBatch(tasks, maxWaitMs = 360000) {
  const start = Date.now();
  const remaining = new Set(tasks.map((_, i) => i));
  const results = new Array(tasks.length).fill(null);
  process.stdout.write('  Polling');
  while (remaining.size > 0 && Date.now() - start < maxWaitMs) {
    await sleep(5000);
    process.stdout.write('.');
    for (const i of [...remaining]) {
      const { status, url } = await pollOne(tasks[i].taskId);
      if (status === 'succeed') { process.stdout.write(` ✓${tasks[i].name}`); results[i] = url; remaining.delete(i); }
      else if (status === 'failed') { process.stdout.write(` ✗${tasks[i].name}`); remaining.delete(i); }
    }
  }
  console.log('');
  return results;
}

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const dest = createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.body.pipeTo(new WritableStream({
      write(chunk) { dest.write(chunk); },
      close() { dest.end(); resolve(); },
      abort(err) { dest.destroy(); reject(err); },
    }));
  });
  return `${(dest.bytesWritten / 1024 / 1024).toFixed(1)}MB`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const S = 'no logos or text on screen, handheld camera, realistic, Australian';

const ALL_CLIPS = [
  {
    name: 'leaking-tap-treatment-b',
    file: 'leaking-tap-treatment-b.mp4',
    dir:  'plumbing/leaking-tap',
    prompt: `licensed plumber replaces worn tap washer, water dripping from bathroom tap stops completely, close up of dry tap, satisfied plumber smiles, ${S}`,
  },
  {
    name: 'deep-clean-hook-c',
    file: 'deep-clean-hook-c.mp4',
    dir:  'house-cleaning/deep-clean',
    prompt: `montage of neglected areas inside Australian home — thick dust on ceiling fan blades, grease behind stove, dark mould in shower grout, cobwebs in corners, ${S}`,
  },
  {
    name: 'deep-clean-treatment-c',
    file: 'deep-clean-treatment-c.mp4',
    dir:  'house-cleaning/deep-clean',
    prompt: `professional cleaner steam-cleans grout lines in bathroom, scrubs skirting boards, pulls out fridge to clean behind it, methodical and thorough, ${S}`,
  },
];

async function main() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  console.log(`\nRound 7 — ${ALL_CLIPS.length} clips × ${CREDITS_PER_CLIP} credits = ${ALL_CLIPS.length * CREDITS_PER_CLIP} credits`);
  console.log('Check balance: https://klingai.com/global/dev/console\n');

  if (args['dry-run']) {
    for (const c of ALL_CLIPS) console.log(`  [${c.dir}] ${c.name}:\n    ${c.prompt}\n`);
    return;
  }

  // Skip already-downloaded
  const toGenerate = ALL_CLIPS.filter(c => {
    const dest = path.join(CLIPS_ROOT, c.dir, c.file);
    if (existsSync(dest)) { console.log(`  Skipping ${c.name} — already exists`); return false; }
    return true;
  });

  if (!toGenerate.length) { console.log('All clips already exist.'); return; }

  const tasks = [];
  for (const clip of toGenerate) {
    process.stdout.write(`  [${clip.name}] submitting...`);
    const taskId = await submit(clip.prompt);
    console.log(` → ${taskId}`);
    tasks.push({ ...clip, taskId });
    await sleep(500);
  }

  const urls = await pollBatch(tasks);
  let completed = 0;
  for (const [i, clip] of tasks.entries()) {
    const url = urls[i];
    if (!url) { console.log(`  ✗ ${clip.name} — failed`); continue; }
    const destDir = path.join(CLIPS_ROOT, clip.dir);
    mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, clip.file);
    process.stdout.write(`  Downloading ${clip.file}...`);
    console.log(` ${await download(url, destPath)} ✓`);
    completed++;
  }

  console.log(`\n=== Round 7 complete — ${completed}/${toGenerate.length} clips ===`);
  console.log('Next: node src/video/r2-upload.js   (upload new clips)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
