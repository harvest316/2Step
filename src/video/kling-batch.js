#!/usr/bin/env node

/**
 * Batch Kling clip generator — submits clips in groups of 3, polls to completion,
 * downloads each MP4 to the local clips/ directory.
 *
 * Define BATCHES below and run:
 *   node src/video/kling-batch.js
 *   node src/video/kling-batch.js --dry-run
 */

import '../utils/load-env.js';
import { createHmac } from 'crypto';
import { mkdirSync, createWriteStream } from 'fs';
import { parseArgs } from 'util';
import path from 'path';

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const KLING_API_BASE   = 'https://api.klingai.com/v1';
const CLIPS_ROOT       = new URL('../../clips', import.meta.url).pathname;

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

const S = 'no logos or text on clothing, handheld camera, realistic';

/**
 * Each clip: { name, file, dir, prompt }
 * dir is relative to CLIPS_ROOT
 */
const ALL_CLIPS = [
  // ── Cockroach treatment (need f, g — already have a,c,e) ──────────────────
  { name: 'pc-treatment-f', file: 'pest-control-treatment-f.mp4', dir: 'pest-control/cockroaches',
    prompt: `pest control technician in white uniform drilling into wall cavity beside skirting board injecting pesticide, focused, Australian home, ${S}` },
  { name: 'pc-treatment-g', file: 'pest-control-treatment-g.mp4', dir: 'pest-control/cockroaches',
    prompt: `pest control technician applying gel bait inside kitchen cabinet with precision applicator gun, close up, Australian home, ${S}` },

  // ── Shared: technician (need e — already have a,b,c,d) ───────────────────
  { name: 'shared-tech-e', file: 'shared-technician-e.mp4', dir: 'pest-control/shared',
    prompt: `pest control technician in white uniform walking up driveway of Australian suburban home carrying equipment bag, confident stride, sunny day, ${S}` },

  // ── Shared: resolution (need d,e — already have a,b,c) ───────────────────
  { name: 'shared-res-d', file: 'shared-resolution-d.mp4', dir: 'pest-control/shared',
    prompt: `Australian family laughing together at kitchen table, bright sunny morning, clean tidy home, warm relaxed atmosphere, ${S}` },
  { name: 'shared-res-e', file: 'shared-resolution-e.mp4', dir: 'pest-control/shared',
    prompt: `woman opening kitchen cabinet confidently, clean and pest-free, smiling with relief, bright Australian kitchen, ${S}` },

  // ── Shared: cta (need b,c — already have a,d,e) ──────────────────────────
  { name: 'shared-cta-b', file: 'shared-cta-b.mp4', dir: 'pest-control/shared',
    prompt: `pest control technician in white uniform giving confident thumbs up at front door of Australian suburban house, sunny day, ${S}` },
  { name: 'shared-cta-c', file: 'shared-cta-c.mp4', dir: 'pest-control/shared',
    prompt: `satisfied homeowner shaking hands with pest control technician in white uniform at front door, both smiling, Australian suburb, sunny, ${S}` },

  // ── Termites: hook (need b,c,d,e — already have a) ───────────────────────
  { name: 'termites-hook-b', file: 'termites-hook-b.mp4', dir: 'pest-control/termites',
    prompt: `homeowner taps wooden skirting board and it crumbles revealing termite damage inside wall, shocked expression, Australian home interior, ${S}` },
  { name: 'termites-hook-c', file: 'termites-hook-c.mp4', dir: 'pest-control/termites',
    prompt: `close up of termite mud tunnels running up wall inside Australian home, hand pulls back architrave revealing termites, ${S}` },
  { name: 'termites-hook-d', file: 'termites-hook-d.mp4', dir: 'pest-control/termites',
    prompt: `homeowner discovers termite damage in wooden door frame of Australian home, pushes finger through soft wood in disbelief, ${S}` },
  { name: 'termites-hook-e', file: 'termites-hook-e.mp4', dir: 'pest-control/termites',
    prompt: `couple discovers termite mud trails behind wall panel in Australian home, look at each other in alarm, ${S}` },

  // ── Termites: treatment (need b,c,d,e — already have a) ──────────────────
  { name: 'termites-treatment-b', file: 'termites-treatment-b.mp4', dir: 'pest-control/termites',
    prompt: `pest control technician drilling into wall beside skirting board injecting termiticide with professional equipment, Australian home interior, ${S}` },
  { name: 'termites-treatment-c', file: 'termites-treatment-c.mp4', dir: 'pest-control/termites',
    prompt: `pest control technician setting up termite baiting stations in garden soil around Australian home perimeter, methodical, ${S}` },
  { name: 'termites-treatment-d', file: 'termites-treatment-d.mp4', dir: 'pest-control/termites',
    prompt: `pest control technician using moisture meter to scan walls of Australian home for termite activity, focused and professional, ${S}` },
  { name: 'termites-treatment-e', file: 'termites-treatment-e.mp4', dir: 'pest-control/termites',
    prompt: `pest control technician crawling under Australian house with torch inspecting subfloor for termite damage, professional, ${S}` },

  // ── Spiders: hook (need c,d,e — already have a,b) ────────────────────────
  { name: 'spiders-hook-c', file: 'spiders-hook-c.mp4', dir: 'pest-control/spiders',
    prompt: `person reaches into garden shed and recoils from large redback spider on web in corner, Australian backyard, ${S}` },
  { name: 'spiders-hook-d', file: 'spiders-hook-d.mp4', dir: 'pest-control/spiders',
    prompt: `child spots large huntsman spider on bedroom wall at night, parent rushes in alarmed, Australian home interior, ${S}` },
  { name: 'spiders-hook-e', file: 'spiders-hook-e.mp4', dir: 'pest-control/spiders',
    prompt: `woman pulls back outdoor furniture cushion revealing spider nest underneath, gasps and steps back, Australian backyard, ${S}` },

  // ── Spiders: treatment (need b,c,d,e — already have a) ───────────────────
  { name: 'spiders-treatment-b', file: 'spiders-treatment-b.mp4', dir: 'pest-control/spiders',
    prompt: `pest control technician in white uniform spraying along fence line and garden beds in Australian backyard, methodical, ${S}` },
  { name: 'spiders-treatment-c', file: 'spiders-treatment-c.mp4', dir: 'pest-control/spiders',
    prompt: `pest control technician applying chemical barrier around exterior foundations of Australian home, professional equipment, ${S}` },
  { name: 'spiders-treatment-d', file: 'spiders-treatment-d.mp4', dir: 'pest-control/spiders',
    prompt: `pest control technician removing large spider webs from ceiling corners of Australian home with professional extension tool, ${S}` },
  { name: 'spiders-treatment-e', file: 'spiders-treatment-e.mp4', dir: 'pest-control/spiders',
    prompt: `pest control technician inspecting garden shed doorframe and spraying crevices for spiders, Australian backyard, ${S}` },

  // ── Rodents: hook (need c,d,e — already have a,b) ────────────────────────
  { name: 'rodents-hook-c', file: 'rodents-hook-c.mp4', dir: 'pest-control/rodents',
    prompt: `woman opens kitchen pantry and small mouse darts behind cereal boxes, she gasps and steps back, Australian kitchen, ${S}` },
  { name: 'rodents-hook-d', file: 'rodents-hook-d.mp4', dir: 'pest-control/rodents',
    prompt: `person discovers rat droppings and chewed food packaging in kitchen drawer, recoils in disgust, Australian home, ${S}` },
  { name: 'rodents-hook-e', file: 'rodents-hook-e.mp4', dir: 'pest-control/rodents',
    prompt: `homeowner hears scratching inside wall at night, presses ear against wall with worried expression, Australian home, ${S}` },

  // ── Rodents: treatment (need b,c,d,e — already have a) ───────────────────
  { name: 'rodents-treatment-b', file: 'rodents-treatment-b.mp4', dir: 'pest-control/rodents',
    prompt: `pest control technician placing professional rodent bait stations along wall behind kitchen appliances, methodical, Australian home, ${S}` },
  { name: 'rodents-treatment-c', file: 'rodents-treatment-c.mp4', dir: 'pest-control/rodents',
    prompt: `pest control technician sealing entry point gap under exterior door with professional materials, Australian home, ${S}` },
  { name: 'rodents-treatment-d', file: 'rodents-treatment-d.mp4', dir: 'pest-control/rodents',
    prompt: `pest control technician inspecting roof void with torch for rodent activity, Australian home, professional, ${S}` },
  { name: 'rodents-treatment-e', file: 'rodents-treatment-e.mp4', dir: 'pest-control/rodents',
    prompt: `pest control technician placing snap traps along skirting board in Australian garage, methodical and professional, ${S}` },
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

  const total = ALL_CLIPS.length;
  console.log(`\nRound 2 — ${total} clips across ${chunkOf3(ALL_CLIPS).length} batches\n`);

  if (args['dry-run']) {
    for (const c of ALL_CLIPS) console.log(`  [${c.dir}] ${c.name}: ${c.prompt.substring(0, 80)}...`);
    return;
  }

  let completed = 0;
  for (const [bi, batch] of chunkOf3(ALL_CLIPS).entries()) {
    console.log(`\n--- Batch ${bi + 1}/${chunkOf3(ALL_CLIPS).length}: ${batch.map(c => c.name).join(', ')} ---`);

    // Submit
    const tasks = [];
    for (const clip of batch) {
      process.stdout.write(`  [${clip.name}] submitting...`);
      const taskId = await submit(clip.prompt);
      console.log(` → ${taskId}`);
      tasks.push({ ...clip, taskId });
    }

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

  console.log(`\n=== Round 2 complete — ${completed}/${total} clips downloaded ===\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
