#!/usr/bin/env node

/**
 * Round 6 — Bulk up thin pools to ≥3 clips per slot.
 *
 * Targets (existing → target):
 *   leaking-tap:      hook 1→3, treatment 1→3  (+2 +2 = 4)
 *   burst-pipe:       treatment 1→3             (+2 = 2)
 *   greasy-rangehood: hook 1→3                  (+2 = 2)
 *   dirty-bathroom:   hook 1→3, treatment 1→3   (+2 +2 = 4)
 *   end-of-lease:     hook 1→3, treatment 1→3   (+2 +2 = 4)
 *   deep-clean:       hook 1→3, treatment 1→3   (+2 +2 = 4)
 *   hot-water:        hook 0→3, treatment 0→3   (+3 +3 = 6)
 *
 * Total: 26 clips × 8 credits = 208 credits → ~452 remaining (above 250 floor)
 *
 * Usage:
 *   node src/video/kling-batch-round6.js
 *   node src/video/kling-batch-round6.js --dry-run
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

async function pollBatch(tasks, maxWaitMs = 420000) {
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

const S = 'no logos or text on screen, handheld camera, realistic, Australian';

const ALL_CLIPS = [
  // ── leaking-tap (+2 hook, +2 treatment) ──────────────────────────────────
  { name: 'leaking-tap-hook-b', file: 'leaking-tap-hook-b.mp4', dir: 'plumbing/leaking-tap',
    prompt: `extreme close up of kitchen tap dripping steadily, water droplets falling into sink, ${S} home` },
  { name: 'leaking-tap-hook-c', file: 'leaking-tap-hook-c.mp4', dir: 'plumbing/leaking-tap',
    prompt: `homeowner crouches under bathroom vanity looking frustrated at wet pipe joint, puddle forming on floor, ${S}` },
  { name: 'leaking-tap-treatment-b', file: 'leaking-tap-treatment-b.mp4', dir: 'plumbing/leaking-tap',
    prompt: `plumber tightens tap washer with wrench, water drip stops, satisfied plumber checks tap, ${S} bathroom` },
  { name: 'leaking-tap-treatment-c', file: 'leaking-tap-treatment-c.mp4', dir: 'plumbing/leaking-tap',
    prompt: `plumber replaces tap cartridge under kitchen sink, professional tools spread out neatly, ${S}` },

  // ── burst-pipe (+2 treatment) ─────────────────────────────────────────────
  { name: 'burst-pipe-treatment-b', file: 'burst-pipe-treatment-b.mp4', dir: 'plumbing/burst-pipe',
    prompt: `plumber cuts out damaged burst pipe section and solders in new copper pipe fitting, ${S} wall cavity` },
  { name: 'burst-pipe-treatment-c', file: 'burst-pipe-treatment-c.mp4', dir: 'plumbing/burst-pipe',
    prompt: `emergency plumber wraps burst pipe with repair clamp stopping water spray, relief on homeowner face, ${S}` },

  // ── greasy-rangehood (+2 hook) ────────────────────────────────────────────
  { name: 'greasy-rangehood-hook-b', file: 'greasy-rangehood-hook-b.mp4', dir: 'house-cleaning/greasy-rangehood',
    prompt: `homeowner points up at extremely greasy grimy kitchen exhaust fan hood above stove, visible grease dripping, disgusted expression, ${S}` },
  { name: 'greasy-rangehood-hook-c', file: 'greasy-rangehood-hook-c.mp4', dir: 'house-cleaning/greasy-rangehood',
    prompt: `close up of range hood extractor filter caked in thick yellow grease and cooking residue, ${S} kitchen` },

  // ── dirty-bathroom (+2 hook, +2 treatment) ────────────────────────────────
  { name: 'dirty-bathroom-hook-b', file: 'dirty-bathroom-hook-b.mp4', dir: 'house-cleaning/dirty-bathroom',
    prompt: `filthy bathroom with soap scum on glass shower screen, mould on grout, grimy toilet, ${S} residential` },
  { name: 'dirty-bathroom-hook-c', file: 'dirty-bathroom-hook-c.mp4', dir: 'house-cleaning/dirty-bathroom',
    prompt: `homeowner grimaces opening shower door revealing heavy soap scum buildup and mould on tiles, ${S}` },
  { name: 'dirty-bathroom-treatment-b', file: 'dirty-bathroom-treatment-b.mp4', dir: 'house-cleaning/dirty-bathroom',
    prompt: `professional cleaner scrubs mould from bathroom grout with stiff brush, tiles transforming from black to white, ${S}` },
  { name: 'dirty-bathroom-treatment-c', file: 'dirty-bathroom-treatment-c.mp4', dir: 'house-cleaning/dirty-bathroom',
    prompt: `cleaner polishes glass shower screen removing soap scum, squeegees it sparkling clear, ${S} bathroom` },

  // ── end-of-lease (+2 hook, +2 treatment) ─────────────────────────────────
  { name: 'end-of-lease-hook-b', file: 'end-of-lease-hook-b.mp4', dir: 'house-cleaning/end-of-lease',
    prompt: `stressed tenant surrounded by moving boxes in dirty empty apartment, looking overwhelmed at mess, ${S}` },
  { name: 'end-of-lease-hook-c', file: 'end-of-lease-hook-c.mp4', dir: 'house-cleaning/end-of-lease',
    prompt: `property manager inspects empty rental property pointing at stains on carpet and dirty walls, tenant looking anxious, ${S}` },
  { name: 'end-of-lease-treatment-b', file: 'end-of-lease-treatment-b.mp4', dir: 'house-cleaning/end-of-lease',
    prompt: `cleaning team works efficiently through empty apartment doing thorough end of lease clean, steam cleaning carpet, ${S}` },
  { name: 'end-of-lease-treatment-c', file: 'end-of-lease-treatment-c.mp4', dir: 'house-cleaning/end-of-lease',
    prompt: `cleaner does final walkthrough of sparkling clean empty apartment, property manager nods approval and hands back bond, ${S}` },

  // ── deep-clean (+2 hook, +2 treatment) ───────────────────────────────────
  { name: 'deep-clean-hook-b', file: 'deep-clean-hook-b.mp4', dir: 'house-cleaning/deep-clean',
    prompt: `neglected home interior with dust on every surface, cluttered and grimy kitchen, homeowner looks exhausted and defeated, ${S}` },
  { name: 'deep-clean-hook-c', file: 'deep-clean-hook-c.mp4', dir: 'house-cleaning/deep-clean',
    prompt: `close ups of dust buildup on ceiling fans, grimy skirting boards, dirty oven interior, ${S} Australian home` },
  { name: 'deep-clean-treatment-b', file: 'deep-clean-treatment-b.mp4', dir: 'house-cleaning/deep-clean',
    prompt: `team of cleaners work systematically through home with professional equipment, steam cleaners vacuums microfibre cloths, ${S}` },
  { name: 'deep-clean-treatment-c', file: 'deep-clean-treatment-c.mp4', dir: 'house-cleaning/deep-clean',
    prompt: `cleaner wipes down skirting boards and cleans behind appliances during thorough deep clean, ${S} home` },

  // ── hot-water (+3 hook, +3 treatment) ────────────────────────────────────
  { name: 'hot-water-hook-a', file: 'hot-water-hook-a.mp4', dir: 'plumbing/hot-water',
    prompt: `person turns on shower tap and recoils as only cold water comes out, frustration visible, ${S} bathroom` },
  { name: 'hot-water-hook-b', file: 'hot-water-hook-b.mp4', dir: 'plumbing/hot-water',
    prompt: `homeowner discovers hot water heater leaking water onto floor of utility room, worried expression, ${S}` },
  { name: 'hot-water-hook-c', file: 'hot-water-hook-c.mp4', dir: 'plumbing/hot-water',
    prompt: `close up of old corroded hot water system with rust stains and signs of failure, ${S} garage or utility room` },
  { name: 'hot-water-treatment-a', file: 'hot-water-treatment-a.mp4', dir: 'plumbing/hot-water',
    prompt: `plumber installs new hot water heater system, connecting pipes and checking pressure, professional and efficient, ${S}` },
  { name: 'hot-water-treatment-b', file: 'hot-water-treatment-b.mp4', dir: 'plumbing/hot-water',
    prompt: `plumber diagnoses faulty hot water system with pressure gauge, explains issue to homeowner, ${S}` },
  { name: 'hot-water-treatment-c', file: 'hot-water-treatment-c.mp4', dir: 'plumbing/hot-water',
    prompt: `homeowner tests newly restored hot water from tap, steam rising, relieved and happy, plumber gives thumbs up, ${S}` },
];

// Kling parallel task limit is 3 per resource pack
const BATCH_SIZE = 3;

async function main() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  const total = ALL_CLIPS.length;
  const cost  = total * CREDITS_PER_CLIP;
  console.log(`\nRound 6 — ${total} clips × ${CREDITS_PER_CLIP} credits = ${cost} credits`);
  console.log(`Balance: check https://klingai.com/global/dev/console (660 credits visible as of today)\n`);

  // Skip already-downloaded clips
  const toGenerate = ALL_CLIPS.filter(c => {
    const dest = path.join(CLIPS_ROOT, c.dir, c.file);
    if (existsSync(dest)) { console.log(`  Skipping ${c.name} (already exists)`); return false; }
    return true;
  });

  if (toGenerate.length === 0) { console.log('All clips already exist.'); return; }

  if (args['dry-run']) {
    console.log(`Dry run — ${toGenerate.length} clips to generate:`);
    for (const c of toGenerate) console.log(`  [${c.dir}] ${c.name}`);
    return;
  }

  let completed = 0;
  for (let i = 0; i < toGenerate.length; i += BATCH_SIZE) {
    const batch = toGenerate.slice(i, i + BATCH_SIZE);
    console.log(`\n--- Batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.map(c => c.name).join(', ')}) ---`);

    const tasks = [];
    for (const clip of batch) {
      process.stdout.write(`  [${clip.name}] submitting...`);
      const taskId = await submit(clip.prompt);
      console.log(` → ${taskId}`);
      tasks.push({ ...clip, taskId });
      await sleep(500); // brief pause between submissions
    }

    const urls = await pollBatch(tasks);
    for (const [j, clip] of tasks.entries()) {
      const url = urls[j];
      if (!url) { console.log(`  ✗ ${clip.name} — failed`); continue; }
      const destDir = path.join(CLIPS_ROOT, clip.dir);
      mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, clip.file);
      process.stdout.write(`  Downloading ${clip.file}...`);
      console.log(` ${await download(url, destPath)} ✓`);
      completed++;
    }
  }

  console.log(`\n=== Round 6 complete — ${completed}/${toGenerate.length} clips ===`);
  console.log('Next: node src/video/r2-upload.js && node src/video/shotstack.js --limit 30\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
