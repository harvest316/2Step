#!/usr/bin/env node

/**
 * Round 3 — New verticals: plumbing + house cleaning
 *
 * 30 clips total (3 per slot × 5 slots × 2 verticals).
 * Each kling-v3 pro 5s clip costs ~8 credits.
 * We had ~544 credits after round 2. 30 × 8 = 240 credits spent → ~304 left (above 250 stop floor).
 *
 * Stop guard: checks credit estimate before each batch — aborts if projected spend
 * would drop remaining balance below CREDIT_FLOOR (250).
 *
 * Usage:
 *   node src/video/kling-batch-round3.js
 *   node src/video/kling-batch-round3.js --dry-run
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

// Credits per clip (kling-v3 pro, 5s). Stop before we drop below this.
const CREDITS_PER_CLIP = 8;
const CREDIT_FLOOR     = 250;

// Best-guess starting balance (manual: started with 1000, used ~57×8=456, left ~544)
// This is tracked locally — Kling API has no balance endpoint.
let estimatedCredits = 544;

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  strict: false,
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

function klingJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 })).toString('base64url');
  const sig = createHmac('sha256', KLING_SECRET_KEY).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ─── API ──────────────────────────────────────────────────────────────────────

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
      if (status === 'succeed') {
        process.stdout.write(` ✓${tasks[i].name}`);
        results[i] = url;
        remaining.delete(i);
      } else if (status === 'failed') {
        process.stdout.write(` ✗${tasks[i].name}`);
        remaining.delete(i);
      }
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
  const size = (dest.bytesWritten / 1024 / 1024).toFixed(1);
  return `${size}MB`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Clip definitions ─────────────────────────────────────────────────────────

const S = 'no logos or text on clothing, handheld camera, realistic, Australian';

const ALL_CLIPS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // PLUMBING  (clips/plumbing/{hook,technician,treatment,resolution,cta})
  // ═══════════════════════════════════════════════════════════════════════════

  // hook — the problem moment (blocked drain, burst pipe, etc.)
  { name: 'plumbing-hook-a', file: 'plumbing-hook-a.mp4', dir: 'plumbing/hook',
    prompt: `homeowner stares in panic as water pours from burst pipe under kitchen sink, grabs towels frantically, ${S} home` },
  { name: 'plumbing-hook-b', file: 'plumbing-hook-b.mp4', dir: 'plumbing/hook',
    prompt: `shower drain completely blocked, water rising around feet, person looks frustrated and checks drain, ${S} bathroom` },
  { name: 'plumbing-hook-c', file: 'plumbing-hook-c.mp4', dir: 'plumbing/hook',
    prompt: `toilet overflowing, water on bathroom floor, homeowner looks horrified, ${S} home` },

  // technician — plumber arriving / getting to work
  { name: 'plumbing-tech-a', file: 'plumbing-technician-a.mp4', dir: 'plumbing/technician',
    prompt: `licensed plumber in neat uniform arriving at front door of Australian suburban home, carrying toolbox, professional and friendly, ${S}` },
  { name: 'plumbing-tech-b', file: 'plumbing-technician-b.mp4', dir: 'plumbing/technician',
    prompt: `plumber kneeling under kitchen sink inspecting pipes with torch, focused, ${S} home interior, professional workwear` },
  { name: 'plumbing-tech-c', file: 'plumbing-technician-c.mp4', dir: 'plumbing/technician',
    prompt: `plumber using drain snake to clear blocked pipe, methodical professional technique, ${S} bathroom` },

  // treatment — fixing the problem
  { name: 'plumbing-treatment-a', file: 'plumbing-treatment-a.mp4', dir: 'plumbing/treatment',
    prompt: `plumber replacing burst copper pipe section, soldering joint with professional torch, ${S} home laundry` },
  { name: 'plumbing-treatment-b', file: 'plumbing-treatment-b.mp4', dir: 'plumbing/treatment',
    prompt: `plumber using high-pressure water jet to clear blocked drain, water flowing freely again, ${S} home exterior` },
  { name: 'plumbing-treatment-c', file: 'plumbing-treatment-c.mp4', dir: 'plumbing/treatment',
    prompt: `plumber installing new tap on bathroom basin, tightening fittings, clean professional work, ${S} home` },

  // resolution — problem solved, happy homeowner
  { name: 'plumbing-resolution-a', file: 'plumbing-resolution-a.mp4', dir: 'plumbing/resolution',
    prompt: `homeowner turns on kitchen tap, water flows perfectly, smiles with relief, ${S} home kitchen, bright and clean` },
  { name: 'plumbing-resolution-b', file: 'plumbing-resolution-b.mp4', dir: 'plumbing/resolution',
    prompt: `couple inspect under-sink area — dry, pipes repaired, both relieved and happy, ${S} home kitchen` },
  { name: 'plumbing-resolution-c', file: 'plumbing-resolution-c.mp4', dir: 'plumbing/resolution',
    prompt: `shower drain flowing freely, woman steps into clean shower happily, ${S} bathroom, bright` },

  // cta — plumber wrapping up, handshake
  { name: 'plumbing-cta-a', file: 'plumbing-cta-a.mp4', dir: 'plumbing/cta',
    prompt: `plumber in uniform gives confident thumbs up at front door of Australian suburban home, sunny day, job done, ${S}` },
  { name: 'plumbing-cta-b', file: 'plumbing-cta-b.mp4', dir: 'plumbing/cta',
    prompt: `satisfied homeowner shakes hands with plumber at front door, both smiling, Australian suburban home, sunny, ${S}` },
  { name: 'plumbing-cta-c', file: 'plumbing-cta-c.mp4', dir: 'plumbing/cta',
    prompt: `plumber packs up toolbox neatly at front door, homeowner watches approvingly, ${S} home, professional finish` },

  // ═══════════════════════════════════════════════════════════════════════════
  // HOUSE CLEANING  (clips/house-cleaning/{hook,technician,treatment,resolution,cta})
  // ═══════════════════════════════════════════════════════════════════════════

  // hook — the mess / stress moment
  { name: 'cleaning-hook-a', file: 'house-cleaning-hook-a.mp4', dir: 'house-cleaning/hook',
    prompt: `stressed woman stands in cluttered messy living room, overwhelmed, looking around not knowing where to start, ${S} home` },
  { name: 'cleaning-hook-b', file: 'house-cleaning-hook-b.mp4', dir: 'house-cleaning/hook',
    prompt: `person scrubbing bathroom tiles with no success, grout is grimy, looks frustrated and tired, ${S} bathroom` },
  { name: 'cleaning-hook-c', file: 'house-cleaning-hook-c.mp4', dir: 'house-cleaning/hook',
    prompt: `kitchen bench covered in dirty dishes, person stares exhausted after long day, ${S} home kitchen` },

  // technician — cleaner arriving / starting
  { name: 'cleaning-tech-a', file: 'house-cleaning-technician-a.mp4', dir: 'house-cleaning/technician',
    prompt: `professional house cleaner in uniform arrives at front door of Australian suburban home with cleaning caddy, friendly smile, ${S}` },
  { name: 'cleaning-tech-b', file: 'house-cleaning-technician-b.mp4', dir: 'house-cleaning/technician',
    prompt: `professional cleaner vacuuming living room carpet with industrial vacuum cleaner, efficient and thorough, ${S} home` },
  { name: 'cleaning-tech-c', file: 'house-cleaning-technician-c.mp4', dir: 'house-cleaning/technician',
    prompt: `cleaner in apron scrubbing bathroom tiles with professional equipment, focused and thorough, ${S} bathroom` },

  // treatment — deep cleaning in action
  { name: 'cleaning-treatment-a', file: 'house-cleaning-treatment-a.mp4', dir: 'house-cleaning/treatment',
    prompt: `professional cleaner steam cleaning kitchen benchtop, wiping down surfaces methodically, sparkling result, ${S} home` },
  { name: 'cleaning-treatment-b', file: 'house-cleaning-treatment-b.mp4', dir: 'house-cleaning/treatment',
    prompt: `cleaner polishing hardwood floors with professional mop, floor gleaming, ${S} home living room` },
  { name: 'cleaning-treatment-c', file: 'house-cleaning-treatment-c.mp4', dir: 'house-cleaning/treatment',
    prompt: `professional cleaner wiping inside oven until it shines, before-after reveal, ${S} kitchen` },

  // resolution — sparkling clean home, happy owner
  { name: 'cleaning-resolution-a', file: 'house-cleaning-resolution-a.mp4', dir: 'house-cleaning/resolution',
    prompt: `woman walks into immaculate sparkling clean living room, takes a deep breath of satisfaction, ${S} home, bright` },
  { name: 'cleaning-resolution-b', file: 'house-cleaning-resolution-b.mp4', dir: 'house-cleaning/resolution',
    prompt: `family arrives home to perfectly clean house, kids run in excited, parents smile, ${S} home, warm light` },
  { name: 'cleaning-resolution-c', file: 'house-cleaning-resolution-c.mp4', dir: 'house-cleaning/resolution',
    prompt: `woman runs finger along clean kitchen bench — spotless, smiles and nods approvingly, ${S} bright kitchen` },

  // cta — cleaner at door wrapping up
  { name: 'cleaning-cta-a', file: 'house-cleaning-cta-a.mp4', dir: 'house-cleaning/cta',
    prompt: `professional house cleaner in uniform gives thumbs up at front door of Australian home, sunny day, confident and friendly, ${S}` },
  { name: 'cleaning-cta-b', file: 'house-cleaning-cta-b.mp4', dir: 'house-cleaning/cta',
    prompt: `homeowner shakes hands with house cleaner at front door, both smiling, Australian suburban home, satisfied, ${S}` },
  { name: 'cleaning-cta-c', file: 'house-cleaning-cta-c.mp4', dir: 'house-cleaning/cta',
    prompt: `cleaner carries equipment out to car, homeowner waves goodbye from front door happily, ${S} suburban home` },
];

// ─── Batch into groups of 3 ───────────────────────────────────────────────────

function chunkOf3(arr) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += 3) chunks.push(arr.slice(i, i + 3));
  return chunks;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  // Skip clips that already exist on disk
  const pending = ALL_CLIPS.filter(c => {
    const dest = path.join(CLIPS_ROOT, c.dir, c.file);
    if (existsSync(dest)) {
      console.log(`  [skip] ${c.name} already exists`);
      return false;
    }
    return true;
  });

  const total = pending.length;
  const batches = chunkOf3(pending);
  console.log(`\nRound 3 — ${total} clips to generate across ${batches.length} batches`);
  console.log(`Estimated credits: ~${estimatedCredits} available, floor: ${CREDIT_FLOOR}\n`);

  if (args['dry-run']) {
    for (const c of pending) console.log(`  [${c.dir}] ${c.name}: ${c.prompt.substring(0, 90)}...`);
    return;
  }

  let completed = 0;
  for (const [bi, batch] of batches.entries()) {
    // Credit guard — stop before hitting floor
    const creditsNeeded = batch.length * CREDITS_PER_CLIP;
    if (estimatedCredits - creditsNeeded < CREDIT_FLOOR) {
      console.log(`\n⛔ Credit guard: ~${estimatedCredits} remaining — spending ${creditsNeeded} would drop below ${CREDIT_FLOOR} floor.`);
      console.log(`   Stopping after ${completed}/${total} clips. Run again when credits are topped up.`);
      break;
    }

    console.log(`\n--- Batch ${bi + 1}/${batches.length}: ${batch.map(c => c.name).join(', ')} ---`);

    // Submit
    const tasks = [];
    for (const clip of batch) {
      process.stdout.write(`  [${clip.name}] submitting...`);
      const taskId = await submit(clip.prompt);
      console.log(` → ${taskId}`);
      tasks.push({ ...clip, taskId });
    }

    // Deduct credits for submitted tasks (even if some fail, credits are consumed on submit)
    estimatedCredits -= batch.length * CREDITS_PER_CLIP;
    console.log(`  Credits remaining: ~${estimatedCredits}`);

    // Poll
    const urls = await pollBatch(tasks);

    // Download
    for (const [i, clip] of tasks.entries()) {
      const url = urls[i];
      if (!url) { console.log(`  ✗ ${clip.name} — failed, skipping`); continue; }
      const destDir = path.join(CLIPS_ROOT, clip.dir);
      mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, clip.file);
      process.stdout.write(`  Downloading ${clip.file}...`);
      const size = await download(url, destPath);
      console.log(` ${size} ✓`);
      completed++;
    }
  }

  console.log(`\n=== Round 3 complete — ${completed}/${total} clips downloaded ===`);
  console.log(`=== Estimated credits remaining: ~${estimatedCredits} ===\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
