#!/usr/bin/env node

/**
 * Round 9 — HIGH priority new problem clip pools.
 *
 * New pools (4 hook + 4 treatment each):
 *
 *   Pest control:
 *     possum         — 8 clips (was falling back to rodents = off-topic)
 *     general-pest   — 8 clips (most common review type with no specific pest)
 *   Plumbing:
 *     toilet         — 8 clips (blocked/running toilet, extremely common)
 *   House cleaning:
 *     regular-clean  — 8 clips (weekly/fortnightly, most common cleaning review)
 *
 * Total: 32 clips × 8 credits = 256 credits
 *
 * MEDIUM priority deferred to TODO.md:
 *   ant, bed-bug, gas-fitting, carpet-floor (+ 5th clip for each high pool)
 *
 * LOW priority skipped entirely:
 *   silverfish, mosquito, flea, bee/wasp, pipe relining,
 *   kitchen plumbing, bathroom renovation, window cleaning
 *
 * Usage:
 *   node src/video/kling-batch-round9.js
 *   node src/video/kling-batch-round9.js --dry-run
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
const CREDIT_FLOOR     = 100;  // stop if estimated balance would drop below this
const BATCH_SIZE       = 3;    // max parallel Kling tasks

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
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${KLING_API_BASE}/videos/text2video`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${klingJwt()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: 'kling-v3', prompt, duration: '5', aspect_ratio: '9:16', mode: 'pro', cfg_scale: 0.7 }),
    });
    if (res.status === 429) {
      const waitSec = 30 * (attempt + 1);
      process.stdout.write(` [429, retry in ${waitSec}s]`);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`submit failed ${res.status}: ${(await res.text()).substring(0, 200)}`);
    const data = await res.json();
    const taskId = data?.data?.task_id;
    if (!taskId) throw new Error(`missing task_id: ${JSON.stringify(data)}`);
    return taskId;
  }
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

async function pollUntilDone(taskId, name, maxWaitMs = 360000) {
  const start = Date.now();
  process.stdout.write('  polling');
  while (Date.now() - start < maxWaitMs) {
    await sleep(8000);
    process.stdout.write('.');
    const { status, url } = await pollOne(taskId);
    if (status === 'succeed') { console.log(` ✓`); return url; }
    if (status === 'failed')  { console.log(` ✗`); return null; }
  }
  console.log(' timeout');
  return null;
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
  // ══════════════════════════════════════════════════════════════════════════════
  // PEST CONTROL — POSSUM (10 clips)
  // ══════════════════════════════════════════════════════════════════════════════
  {
    name: 'possum-hook-a',
    file: 'possum-hook-a.mp4',
    dir:  'pest-control/possum',
    prompt: `possum sitting on roof tiles of Australian suburban home at dusk, close-up of possum face and eyes, scratching noises audible, homeowner looking up at roof concerned, ${S}`,
  },
  {
    name: 'possum-hook-b',
    file: 'possum-hook-b.mp4',
    dir:  'pest-control/possum',
    prompt: `possum droppings and urine stains visible in ceiling cavity of Australian home, insulation torn and damaged by possum activity, torch beam revealing the mess, ${S}`,
  },
  {
    name: 'possum-hook-c',
    file: 'possum-hook-c.mp4',
    dir:  'pest-control/possum',
    prompt: `brushtail possum climbing along power lines and onto roof of Australian weatherboard house at night, security camera footage style, ${S}`,
  },
  {
    name: 'possum-hook-d',
    file: 'possum-hook-d.mp4',
    dir:  'pest-control/possum',
    prompt: `homeowner in bed at night disturbed by loud thumping and scratching noises from ceiling above, possum running across roof cavity, ${S}`,
  },
  {
    name: 'possum-treatment-a',
    file: 'possum-treatment-a.mp4',
    dir:  'pest-control/possum',
    prompt: `pest control technician on ladder inspecting roof cavity entry point of Australian home for possum access, wearing protective gloves and headlamp, ${S}`,
  },
  {
    name: 'possum-treatment-b',
    file: 'possum-treatment-b.mp4',
    dir:  'pest-control/possum',
    prompt: `humane possum trap cage being set up in roof cavity by pest control professional, bait placement, careful positioning near possum entry point, ${S}`,
  },
  {
    name: 'possum-treatment-c',
    file: 'possum-treatment-c.mp4',
    dir:  'pest-control/possum',
    prompt: `pest control technician sealing possum entry points on Australian tile roof with mesh and caulk, blocking gaps under eaves and around pipes, ${S}`,
  },
  {
    name: 'possum-treatment-d',
    file: 'possum-treatment-d.mp4',
    dir:  'pest-control/possum',
    prompt: `installing a possum nesting box on large gum tree in Australian backyard, providing alternative habitat after roof exclusion, ${S}`,
  },

  // ══════════════════════════════════════════════════════════════════════════════
  // PEST CONTROL — GENERAL PEST (10 clips)
  // ══════════════════════════════════════════════════════════════════════════════
  {
    name: 'general-pest-hook-a',
    file: 'general-pest-hook-a.mp4',
    dir:  'pest-control/general-pest',
    prompt: `montage of common household pests in Australian home — ants trailing across kitchen bench, moth flying near pantry, silverfish on bathroom floor, quick cuts between each pest, ${S}`,
  },
  {
    name: 'general-pest-hook-b',
    file: 'general-pest-hook-b.mp4',
    dir:  'pest-control/general-pest',
    prompt: `homeowner opening kitchen cupboard to find trail of ants, moth larvae in cereal box, and tiny insects around the sink — frustrated expression, everyday Australian kitchen, ${S}`,
  },
  {
    name: 'general-pest-hook-c',
    file: 'general-pest-hook-c.mp4',
    dir:  'pest-control/general-pest',
    prompt: `close-up of pest evidence in Australian home — droppings in pantry corners, small holes in food packaging, insect trails along skirting boards, cobwebs in corners, ${S}`,
  },
  {
    name: 'general-pest-hook-d',
    file: 'general-pest-hook-d.mp4',
    dir:  'pest-control/general-pest',
    prompt: `exterior of typical Australian brick home showing pest entry points — gaps under doors, cracks in mortar, weep holes, gaps around pipes, insects visible entering, ${S}`,
  },
  {
    name: 'general-pest-treatment-a',
    file: 'general-pest-treatment-a.mp4',
    dir:  'pest-control/general-pest',
    prompt: `pest control technician in uniform doing full interior spray treatment of Australian home, methodically spraying skirting boards, under sinks, around door frames, ${S}`,
  },
  {
    name: 'general-pest-treatment-b',
    file: 'general-pest-treatment-b.mp4',
    dir:  'pest-control/general-pest',
    prompt: `pest professional spraying exterior perimeter of Australian brick home with professional grade pump sprayer, treating garden beds, foundations, and entry points, ${S}`,
  },
  {
    name: 'general-pest-treatment-c',
    file: 'general-pest-treatment-c.mp4',
    dir:  'pest-control/general-pest',
    prompt: `pest technician applying gel bait and dust insecticide in roof cavity of Australian home using torch and professional equipment, thorough treatment, ${S}`,
  },
  {
    name: 'general-pest-treatment-d',
    file: 'general-pest-treatment-d.mp4',
    dir:  'pest-control/general-pest',
    prompt: `pest control professional inspecting and treating underneath Australian home on stumps, spraying subfloor area and checking for pest activity with torch, ${S}`,
  },



  // ══════════════════════════════════════════════════════════════════════════════
  // PLUMBING — TOILET (10 clips)
  // ══════════════════════════════════════════════════════════════════════════════
  {
    name: 'toilet-hook-a',
    file: 'toilet-hook-a.mp4',
    dir:  'plumbing/toilet',
    prompt: `blocked toilet overflowing onto bathroom floor of Australian home, water rising dangerously in bowl, homeowner panicking and reaching for plunger, ${S}`,
  },
  {
    name: 'toilet-hook-b',
    file: 'toilet-hook-b.mp4',
    dir:  'plumbing/toilet',
    prompt: `toilet constantly running water into bowl, close-up of cistern with faulty flush valve, sound of water trickling non-stop, Australian bathroom, ${S}`,
  },
  {
    name: 'toilet-hook-c',
    file: 'toilet-hook-c.mp4',
    dir:  'plumbing/toilet',
    prompt: `water leaking from base of toilet onto tiled bathroom floor of Australian home, damp patch spreading, homeowner putting down towels, ${S}`,
  },
  {
    name: 'toilet-hook-d',
    file: 'toilet-hook-d.mp4',
    dir:  'plumbing/toilet',
    prompt: `toilet flush that barely works — weak flush, water swirling but not clearing, multiple flush attempts, frustrated homeowner in Australian bathroom, ${S}`,
  },
  {
    name: 'toilet-treatment-a',
    file: 'toilet-treatment-a.mp4',
    dir:  'plumbing/toilet',
    prompt: `plumber using professional drain snake to clear blocked toilet in Australian bathroom, working methodically, toilet clearing successfully, ${S}`,
  },
  {
    name: 'toilet-treatment-b',
    file: 'toilet-treatment-b.mp4',
    dir:  'plumbing/toilet',
    prompt: `plumber replacing internal cistern mechanisms — inlet valve and flush valve, working inside toilet cistern with tools, Australian bathroom, ${S}`,
  },
  {
    name: 'toilet-treatment-c',
    file: 'toilet-treatment-c.mp4',
    dir:  'plumbing/toilet',
    prompt: `plumber installing brand new toilet suite in Australian bathroom, setting bowl on flange, connecting cistern, tightening bolts, professional installation, ${S}`,
  },
  {
    name: 'toilet-treatment-d',
    file: 'toilet-treatment-d.mp4',
    dir:  'plumbing/toilet',
    prompt: `plumber replacing wax ring seal at toilet base, lifting old toilet, cleaning flange, fitting new seal and resetting toilet, Australian bathroom, ${S}`,
  },


  // ══════════════════════════════════════════════════════════════════════════════
  // HOUSE CLEANING — REGULAR CLEAN (10 clips)
  // ══════════════════════════════════════════════════════════════════════════════
  {
    name: 'regular-clean-hook-a',
    file: 'regular-clean-hook-a.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `messy Australian living room — toys on floor, dust on surfaces, dirty coffee table, scattered cushions, busy family home that needs weekly cleaning, ${S}`,
  },
  {
    name: 'regular-clean-hook-b',
    file: 'regular-clean-hook-b.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `busy working parent arriving home to messy kitchen — dishes in sink, crumbs on bench, dirty stovetop, tired expression, Australian suburban home, ${S}`,
  },
  {
    name: 'regular-clean-hook-c',
    file: 'regular-clean-hook-c.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `dust buildup on shelves and venetian blinds in Australian home, cobwebs in ceiling corners, fingerprints on glass, needs a regular clean, ${S}`,
  },
  {
    name: 'regular-clean-hook-d',
    file: 'regular-clean-hook-d.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `panning shot of untidy Australian home — unmade beds, cluttered benchtops, full laundry basket, bathroom mirror with toothpaste spots, everyday mess, ${S}`,
  },
  {
    name: 'regular-clean-treatment-a',
    file: 'regular-clean-treatment-a.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `professional cleaner vacuuming living room carpet and mopping hardwood floors in Australian home, efficient and thorough, wearing uniform, ${S}`,
  },
  {
    name: 'regular-clean-treatment-b',
    file: 'regular-clean-treatment-b.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `cleaner wiping down kitchen benchtops, cleaning stovetop, and organising items on counter in Australian kitchen, spray and wipe, sparkling surfaces, ${S}`,
  },
  {
    name: 'regular-clean-treatment-c',
    file: 'regular-clean-treatment-c.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `professional cleaner making beds with fresh linen, fluffing pillows, dusting bedside tables in Australian bedroom, crisp and tidy result, ${S}`,
  },
  {
    name: 'regular-clean-treatment-d',
    file: 'regular-clean-treatment-d.mp4',
    dir:  'house-cleaning/regular-clean',
    prompt: `cleaner scrubbing bathroom — cleaning toilet, wiping mirrors, scrubbing shower glass, polishing taps in Australian bathroom, gleaming result, ${S}`,
  },

];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  console.log(`Round 9 — ${ALL_CLIPS.length} clips × ${CREDITS_PER_CLIP} credits = ${ALL_CLIPS.length * CREDITS_PER_CLIP} credits`);
  if (args['dry-run']) console.log('DRY RUN — no API calls\n');

  // Skip clips that already exist locally
  const todo = ALL_CLIPS.filter(c => {
    const dest = path.join(CLIPS_ROOT, c.dir, c.file);
    if (existsSync(dest)) { console.log(`  skip (exists): ${c.name}`); return false; }
    return true;
  });

  console.log(`\n${todo.length} clips to generate (${ALL_CLIPS.length - todo.length} already exist)\n`);
  if (args['dry-run']) {
    for (const c of todo) console.log(`  ${c.name}: ${c.prompt.slice(0, 80)}...`);
    return;
  }

  let success = 0, failed = 0, creditsUsed = 0;

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    console.log(`\n─── Batch ${Math.floor(i / BATCH_SIZE) + 1} (clips ${i + 1}–${i + batch.length} of ${todo.length}) ───`);

    // Submit all in batch
    const tasks = [];
    for (const clip of batch) {
      process.stdout.write(`  Submitting ${clip.name}...`);
      try {
        const taskId = await submit(clip.prompt);
        console.log(` ${taskId}`);
        tasks.push({ clip, taskId });
        creditsUsed += CREDITS_PER_CLIP;
      } catch (err) {
        console.log(` FAILED: ${err.message}`);
        failed++;
      }
    }

    // Poll all in batch
    for (const { clip, taskId } of tasks) {
      process.stdout.write(`  ${clip.name}`);
      const url = await pollUntilDone(taskId, clip.name);
      if (!url) { failed++; continue; }

      const dir = path.join(CLIPS_ROOT, clip.dir);
      mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, clip.file);

      try {
        const size = await download(url, dest);
        console.log(`    → ${dest} (${size})`);
        success++;
      } catch (err) {
        console.log(`    download failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone: ${success} generated, ${failed} failed, ~${creditsUsed} credits used`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
