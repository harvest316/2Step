#!/usr/bin/env node

/**
 * Round 5 — Re-generate rangehood clips with correct prompt terminology.
 *
 * Problem: "rangehood" is not understood by Kling (Chinese market uses "kitchen
 * exhaust fan" / "range hood extractor"). Round 3 clips labelled greasy-rangehood
 * showed generic kitchen cleaning / oven cleaning / dirty dishes instead.
 *
 * This round replaces all 3 greasy-rangehood clips:
 *   hook-a      — kitchen with grimy exhaust fan filter, grease dripping
 *   treatment-a — cleaner scrubbing exhaust fan filter / extractor hood
 *   treatment-b — cleaner degreasing kitchen exhaust fan with spray
 *
 * Credits: 3 clips × 8 = 24 credits.
 *
 * Usage:
 *   node src/video/kling-batch-round5.js
 *   node src/video/kling-batch-round5.js --dry-run
 */

import '../utils/load-env.js';
import { createHmac } from 'crypto';
import { mkdirSync, createWriteStream, existsSync, renameSync } from 'fs';
import { parseArgs } from 'util';
import path from 'path';

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const KLING_API_BASE   = 'https://api.klingai.com/v1';
const CLIPS_ROOT       = new URL('../../clips', import.meta.url).pathname;

const CREDITS_PER_CLIP = 8;
const CREDIT_FLOOR     = 250;

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

async function getBalance() {
  const end   = Date.now();
  const start = end - 90 * 24 * 60 * 60 * 1000;
  const res = await fetch(`${KLING_API_BASE}/account/costs?start_time=${start}&end_time=${end}`, {
    headers: { 'Authorization': `Bearer ${klingJwt()}` },
  });
  if (!res.ok) return null; // endpoint not available — skip balance check
  const data = await res.json();
  const packs = data.data?.resource_pack_subscribe_infos ?? [];
  return packs.filter(p => p.status === 'online').reduce((s, p) => s + p.remaining_quantity, 0);
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

// ─── Clip definitions ──────────────────────────────────────────────────────────

// Kling appears to be trained on Chinese-market terminology.
// "Rangehood" is an Australian English term — use "kitchen exhaust fan" or
// "range hood extractor" or "exhaust hood" which appear in global training data.
const S = 'no logos or text on screen, handheld camera, realistic, Australian';

const ALL_CLIPS = [
  // Replace greasy-rangehood-hook-a (showed dirty dishes — wrong)
  { name: 'greasy-rangehood-hook-a', file: 'greasy-rangehood-hook-a.mp4', dir: 'house-cleaning/greasy-rangehood',
    prompt: `close up of heavily greased kitchen exhaust fan filters above stove, thick yellow grease dripping, homeowner grimaces in disgust, ${S} home kitchen` },

  // Replace greasy-rangehood-treatment-a (showed bench cleaning — wrong)
  { name: 'greasy-rangehood-treatment-a', file: 'greasy-rangehood-treatment-a.mp4', dir: 'house-cleaning/greasy-rangehood',
    prompt: `professional cleaner removes greasy exhaust fan filter from above kitchen stove and scrubs it clean with degreaser, transformation visible, ${S}` },

  // Replace greasy-rangehood-treatment-b (showed oven cleaning — close but wrong)
  { name: 'greasy-rangehood-treatment-b', file: 'greasy-rangehood-treatment-b.mp4', dir: 'house-cleaning/greasy-rangehood',
    prompt: `professional cleaner sprays heavy-duty degreaser on kitchen range hood extractor fan and wipes away thick grease buildup, satisfying before-and-after, ${S}` },
];

async function main() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  // Fetch real balance
  const balance = await getBalance();
  const balanceStr = balance !== null
    ? `${balance} credits (from API, ~12h delay)`
    : 'unknown — check https://klingai.com/global/dev/console';
  console.log(`\nKling balance: ${balanceStr}`);

  const total = ALL_CLIPS.length;
  const cost  = total * CREDITS_PER_CLIP;
  console.log(`Round 5 — ${total} clips × ${CREDITS_PER_CLIP} credits = ${cost} credits`);

  if (balance !== null && balance - cost < CREDIT_FLOOR) {
    console.log(`\n⛔ Credit guard: ${balance} remaining — spending ${cost} would drop below ${CREDIT_FLOOR} floor. Aborting.`);
    return;
  }

  if (args['dry-run']) {
    console.log('\nDry run — clips to generate:');
    for (const c of ALL_CLIPS) console.log(`  [${c.dir}] ${c.name}: ${c.prompt.substring(0, 90)}...`);
    return;
  }

  console.log('\nBackup existing clips before overwriting...');
  for (const c of ALL_CLIPS) {
    const dest = path.join(CLIPS_ROOT, c.dir, c.file);
    if (existsSync(dest)) {
      const backup = dest.replace('.mp4', '-backup.mp4');
      renameSync(dest, backup);
      console.log(`  Backed up: ${c.file} → ${c.name}-backup.mp4`);
    }
  }

  // All 3 clips in one batch
  console.log(`\n--- Batch: ${ALL_CLIPS.map(c => c.name).join(', ')} ---`);
  const tasks = [];
  for (const clip of ALL_CLIPS) {
    process.stdout.write(`  [${clip.name}] submitting...`);
    const taskId = await submit(clip.prompt);
    console.log(` → ${taskId}`);
    tasks.push({ ...clip, taskId });
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

  console.log(`\n=== Round 5 complete — ${completed}/${total} clips ===`);
  console.log('Next: node src/video/r2-upload.js  (re-uploads just the changed clips)');
  console.log('      node src/video/kling-balance.js  (check updated balance)\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
