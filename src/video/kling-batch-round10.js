#!/usr/bin/env node

/**
 * Round 10 — Regenerate rejected general-pest clips.
 *
 * Rejected clips (Kling made pests unrealistically large):
 *   general-pest-hook-a, hook-b, hook-d, treatment-c
 *
 * Improved prompts: emphasise realistic/tiny pest sizes, wide shots
 * so pests are small in frame, everyday Australian home context.
 *
 * Total: 4 clips × 8 credits = 32 credits
 *
 * Usage:
 *   node src/video/kling-batch-round10.js
 *   node src/video/kling-batch-round10.js --dry-run
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

const S = 'no logos or text on screen, handheld camera, realistic, Australian, all insects and pests are realistically sized';

const ALL_CLIPS = [
  // Approach: show EVIDENCE of pests and homeowner reaction, not the pests themselves.
  // Kling consistently makes insects oversized — avoid rendering insects entirely.
  {
    name: 'general-pest-hook-a',
    file: 'general-pest-hook-a.mp4',
    dir:  'pest-control/general-pest',
    prompt: `close-up of Australian man's face already mid-grimace, disgusted expression from the very first frame, shaking head and backing away, kitchen background out of focus, the reaction is already happening at the start of the clip, ${S}`,
  },
  {
    name: 'general-pest-hook-b',
    file: 'general-pest-hook-b.mp4',
    dir:  'pest-control/general-pest',
    prompt: `close-up of Australian woman's face as she immediately recoils in disgust and shock, hand over mouth, eyes wide, stepping backwards away from camera, kitchen background blurred, reaction happens instantly at the start of the clip, ${S}`,
  },
  // hook-d APPROVED (v3) — bed at night scratching sounds
  // {
  //   name: 'general-pest-hook-d',
  //   ...
  // },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Round 10 — regenerating ${ALL_CLIPS.length} rejected general-pest clips`);
  console.log(`Est cost: ${ALL_CLIPS.length * 8} credits\n`);

  if (args['dry-run']) {
    for (const c of ALL_CLIPS) {
      console.log(`[DRY] ${c.name}`);
      console.log(`  Prompt: ${c.prompt.slice(0, 120)}...`);
    }
    console.log(`\nDry run — no clips generated.`);
    return;
  }

  const results = [];

  for (const clip of ALL_CLIPS) {
    console.log(`\n[${clip.name}]`);
    console.log(`  Prompt: ${clip.prompt.slice(0, 100)}...`);

    const taskId = await submit(clip.prompt);
    console.log(`  Task: ${taskId}`);

    const videoUrl = await pollUntilDone(taskId, clip.name);
    if (!videoUrl) { console.log(`  ✗ FAILED — skipping`); continue; }

    // Download to clips/
    const dir = path.join(CLIPS_ROOT, clip.dir);
    mkdirSync(dir, { recursive: true });
    const destPath = path.join(dir, clip.file);
    const size = await download(videoUrl, destPath);
    console.log(`  Saved: ${destPath} (${size})`);

    // Also save a flat copy for R2 upload
    const flatPath = path.join(CLIPS_ROOT, clip.file);
    if (!existsSync(flatPath)) {
      const size2 = await download(videoUrl, flatPath);
      console.log(`  Flat:  ${flatPath} (${size2})`);
    }

    results.push({ name: clip.name, file: clip.file, url: videoUrl });
  }

  console.log(`\n═══ Done: ${results.length}/${ALL_CLIPS.length} clips generated ═══`);
  if (results.length < ALL_CLIPS.length) {
    console.log(`  ${ALL_CLIPS.length - results.length} failed — rerun script to retry.`);
  }

  // Print R2 upload commands
  if (results.length > 0) {
    console.log(`\nUpload to R2:`);
    for (const r of results) {
      console.log(`  npx wrangler r2 object put 2step-clips/${r.file} --file clips/${r.file}`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
