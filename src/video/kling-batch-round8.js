#!/usr/bin/env node

/**
 * Round 8 — Fill all pools to 5 clips per slot across all active verticals.
 *
 * Gaps (existing count → adding):
 *   Pest control:
 *     cockroaches treatment:        4 → +1 (e)
 *     spiders hook:                 3 → +2 (c, e)
 *     spiders treatment:            3 → +2 (a, d)
 *     rodents hook:                 4 → +1 (a)
 *   Plumbing shared:
 *     plumbing technician:          3 → +2 (d, e)
 *     plumbing resolution:          3 → +2 (d, e)
 *     plumbing cta:                 3 → +2 (d, e)
 *   Plumbing problems:
 *     blocked-drain hook:           2 → +3 (c, d, e)
 *     blocked-drain treatment:      2 → +3 (c, d, e)
 *     burst-pipe hook:              2 → +3 (c, d, e)
 *     burst-pipe treatment:         3 → +2 (d, e)
 *     leaking-tap hook:             3 → +2 (d, e)
 *     leaking-tap treatment:        3 → +2 (d, e)
 *     hot-water hook:               3 → +2 (d, e)
 *     hot-water treatment:          3 → +2 (d, e)
 *   House cleaning shared:
 *     house-cleaning technician:    3 → +2 (d, e)
 *     house-cleaning resolution:    3 → +2 (d, e)
 *     house-cleaning cta:           3 → +2 (d, e)
 *   House cleaning problems:
 *     greasy-rangehood hook:        3 → +2 (d, e)
 *     greasy-rangehood treatment:   2 → +3 (c, d, e)
 *     dirty-bathroom hook:          3 → +2 (d, e)
 *     dirty-bathroom treatment:     3 → +2 (d, e)
 *     end-of-lease hook:            3 → +2 (d, e)
 *     end-of-lease treatment:       3 → +2 (d, e)
 *     deep-clean hook:              3 → +2 (d, e)
 *     deep-clean treatment:         3 → +2 (d, e)
 *
 * Total: 56 clips × 8 credits = 448 credits
 *
 * Usage:
 *   node src/video/kling-batch-round8.js
 *   node src/video/kling-batch-round8.js --dry-run
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
  // ── Pest control ────────────────────────────────────────────────────────────
  {
    name: 'cockroaches-treatment-e',
    file: 'cockroaches-treatment-e.mp4',
    dir:  'pest-control/cockroaches',
    prompt: `pest control technician wearing protective gear sprays insecticide behind kitchen appliances and under sink to eliminate cockroach infestation, professional and thorough, ${S}`,
  },
  {
    name: 'spiders-hook-c',
    file: 'spiders-hook-c.mp4',
    dir:  'pest-control/spiders',
    prompt: `large spider web with funnel-web or huntsman spider in corner of Australian home garage, close-up of web and spider, homeowner notices and recoils slightly, ${S}`,
  },
  {
    name: 'spiders-hook-e',
    file: 'spiders-hook-e.mp4',
    dir:  'pest-control/spiders',
    prompt: `montage of spider webs in Australian home — behind toilet, under eaves, in wardrobe corners, dusty webs with egg sacs, unsettling close-ups, ${S}`,
  },
  {
    name: 'spiders-treatment-a',
    file: 'spiders-treatment-a.mp4',
    dir:  'pest-control/spiders',
    prompt: `pest control technician in full protective gear applies residual spray along skirting boards and window frames inside Australian home to treat spider infestation, methodical, ${S}`,
  },
  {
    name: 'spiders-treatment-d',
    file: 'spiders-treatment-d.mp4',
    dir:  'pest-control/spiders',
    prompt: `pest control professional dusts roof void and eaves with insecticide powder, removes large spider webs from outside of Australian brick home, comprehensive treatment, ${S}`,
  },
  {
    name: 'rodents-hook-a',
    file: 'rodents-hook-a.mp4',
    dir:  'pest-control/rodents',
    prompt: `mouse or rat droppings found under kitchen sink in Australian home, chewed food packaging in pantry, homeowner shocked discovering the infestation, close-up evidence shots, ${S}`,
  },

  // ── Plumbing shared ─────────────────────────────────────────────────────────
  {
    name: 'plumbing-technician-d',
    file: 'plumbing-technician-d.mp4',
    dir:  'plumbing/shared',
    prompt: `licensed plumber in uniform carrying tool bag arrives at Australian home front door, shakes hands with homeowner and walks inside confidently, ${S}`,
  },
  {
    name: 'plumbing-technician-e',
    file: 'plumbing-technician-e.mp4',
    dir:  'plumbing/shared',
    prompt: `close-up of plumber's hands using adjustable wrench on copper pipe fitting under kitchen sink, professional tools, focused and skilled, ${S}`,
  },
  {
    name: 'plumbing-resolution-d',
    file: 'plumbing-resolution-d.mp4',
    dir:  'plumbing/shared',
    prompt: `plumber shows homeowner the completed repair, both smiling, homeowner tests tap or flush and it works perfectly, relief and satisfaction, Australian home, ${S}`,
  },
  {
    name: 'plumbing-resolution-e',
    file: 'plumbing-resolution-e.mp4',
    dir:  'plumbing/shared',
    prompt: `licensed plumber packs up tools and equipment after successful job, homeowner waves goodbye at front door of Australian home, five-star service moment, ${S}`,
  },
  {
    name: 'plumbing-cta-d',
    file: 'plumbing-cta-d.mp4',
    dir:  'plumbing/shared',
    prompt: `happy Australian family in clean modern kitchen, taps running smoothly, everything working perfectly, warm and comfortable home, ${S}`,
  },
  {
    name: 'plumbing-cta-e',
    file: 'plumbing-cta-e.mp4',
    dir:  'plumbing/shared',
    prompt: `plumber giving thumbs up outside Australian home after completing job, van with plumbing branding in background, professional and trustworthy, ${S}`,
  },

  // ── Blocked drain ───────────────────────────────────────────────────────────
  {
    name: 'blocked-drain-hook-c',
    file: 'blocked-drain-hook-c.mp4',
    dir:  'plumbing/blocked-drain',
    prompt: `shower drain completely blocked with hair and soap scum, water pooling around feet in Australian bathroom, disgusting close-up, homeowner frustrated, ${S}`,
  },
  {
    name: 'blocked-drain-hook-d',
    file: 'blocked-drain-hook-d.mp4',
    dir:  'plumbing/blocked-drain',
    prompt: `kitchen sink drain gurgling and bubbling, water draining very slowly after washing dishes, foul smell, Australian home, homeowner looks concerned, ${S}`,
  },
  {
    name: 'blocked-drain-hook-e',
    file: 'blocked-drain-hook-e.mp4',
    dir:  'plumbing/blocked-drain',
    prompt: `outdoor stormwater drain overflowing during rain, sewage backing up into laundry tub in Australian home, urgent plumbing emergency, ${S}`,
  },
  {
    name: 'blocked-drain-treatment-c',
    file: 'blocked-drain-treatment-c.mp4',
    dir:  'plumbing/blocked-drain',
    prompt: `plumber feeds electric eel drain snake into blocked floor drain, machine rotating and clearing obstruction, water suddenly rushes through freely, ${S}`,
  },
  {
    name: 'blocked-drain-treatment-d',
    file: 'blocked-drain-treatment-d.mp4',
    dir:  'plumbing/blocked-drain',
    prompt: `plumber uses CCTV drain camera to inspect inside sewer pipe, screen shows clear pipe after blockage removed, professional diagnostic equipment, Australian home, ${S}`,
  },
  {
    name: 'blocked-drain-treatment-e',
    file: 'blocked-drain-treatment-e.mp4',
    dir:  'plumbing/blocked-drain',
    prompt: `high-pressure water jet blasting through blocked stormwater pipe outdoors, roots and debris flushing out, drain running clear, plumber operating jetter equipment, ${S}`,
  },

  // ── Burst pipe ──────────────────────────────────────────────────────────────
  {
    name: 'burst-pipe-hook-c',
    file: 'burst-pipe-hook-c.mp4',
    dir:  'plumbing/burst-pipe',
    prompt: `water gushing from burst pipe inside wall cavity of Australian home, water stain spreading across ceiling, homeowner in panic, urgent emergency, ${S}`,
  },
  {
    name: 'burst-pipe-hook-d',
    file: 'burst-pipe-hook-d.mp4',
    dir:  'plumbing/burst-pipe',
    prompt: `flooded hallway in Australian home from burst pipe, water pooling on timber floor, homeowner desperately placing towels, emergency plumbing situation, ${S}`,
  },
  {
    name: 'burst-pipe-hook-e',
    file: 'burst-pipe-hook-e.mp4',
    dir:  'plumbing/burst-pipe',
    prompt: `water meter spinning fast indicating major leak, wet patch growing in garden from underground burst pipe, homeowner standing in flooded backyard, ${S}`,
  },
  {
    name: 'burst-pipe-treatment-d',
    file: 'burst-pipe-treatment-d.mp4',
    dir:  'plumbing/burst-pipe',
    prompt: `plumber soldering copper pipe joint repair inside wall, precision work, torch flame and solder, professional pipe replacement in Australian home, ${S}`,
  },
  {
    name: 'burst-pipe-treatment-e',
    file: 'burst-pipe-treatment-e.mp4',
    dir:  'plumbing/burst-pipe',
    prompt: `plumber pressure testing repaired pipe system with gauge, water pressure holding steady, confirming leak is fully fixed, Australian home, ${S}`,
  },

  // ── Leaking tap ─────────────────────────────────────────────────────────────
  {
    name: 'leaking-tap-hook-d',
    file: 'leaking-tap-hook-d.mp4',
    dir:  'plumbing/leaking-tap',
    prompt: `dripping outdoor garden tap wasting water, puddle forming underneath, close-up of constant drip, Australian backyard, ${S}`,
  },
  {
    name: 'leaking-tap-hook-e',
    file: 'leaking-tap-hook-e.mp4',
    dir:  'plumbing/leaking-tap',
    prompt: `water stain and rust mark on ceramic basin from constantly dripping tap, close-up showing water waste and household damage, Australian bathroom, ${S}`,
  },
  {
    name: 'leaking-tap-treatment-d',
    file: 'leaking-tap-treatment-d.mp4',
    dir:  'plumbing/leaking-tap',
    prompt: `plumber replacing old ceramic disc tap cartridge in kitchen, fitting new cartridge, tap no longer leaks, close-up of dry tap after repair, ${S}`,
  },
  {
    name: 'leaking-tap-treatment-e',
    file: 'leaking-tap-treatment-e.mp4',
    dir:  'plumbing/leaking-tap',
    prompt: `plumber reseating outdoor tap, tightening gland nut to stop leak, wiping dry with cloth, professional repair complete, Australian home exterior, ${S}`,
  },

  // ── Hot water ───────────────────────────────────────────────────────────────
  {
    name: 'hot-water-hook-d',
    file: 'hot-water-hook-d.mp4',
    dir:  'plumbing/hot-water',
    prompt: `person in shower shocked by sudden cold water, wincing and jumping back, hot water system has failed, Australian bathroom, frustrated reaction, ${S}`,
  },
  {
    name: 'hot-water-hook-e',
    file: 'hot-water-hook-e.mp4',
    dir:  'plumbing/hot-water',
    prompt: `old rusty hot water heater leaking from the base, puddle of water underneath, pressure relief valve dripping, Australian home utility area, ${S}`,
  },
  {
    name: 'hot-water-treatment-d',
    file: 'hot-water-treatment-d.mp4',
    dir:  'plumbing/hot-water',
    prompt: `plumber installing brand new heat pump hot water system on side of Australian home, connecting pipes and wiring, modern energy-efficient unit, ${S}`,
  },
  {
    name: 'hot-water-treatment-e',
    file: 'hot-water-treatment-e.mp4',
    dir:  'plumbing/hot-water',
    prompt: `plumber relighting pilot light on gas storage hot water system, adjusting thermostat, system firing up and working again, Australian home, ${S}`,
  },

  // ── House cleaning shared ───────────────────────────────────────────────────
  {
    name: 'house-cleaning-technician-d',
    file: 'house-cleaning-technician-d.mp4',
    dir:  'house-cleaning/shared',
    prompt: `professional house cleaner in uniform arriving at Australian home front door with cleaning caddy and mop, greeted by homeowner, ready to work, ${S}`,
  },
  {
    name: 'house-cleaning-technician-e',
    file: 'house-cleaning-technician-e.mp4',
    dir:  'house-cleaning/shared',
    prompt: `close-up of professional cleaner's hands scrubbing kitchen benchtop with microfibre cloth, spray bottle of cleaning product, thorough and methodical, Australian home, ${S}`,
  },
  {
    name: 'house-cleaning-resolution-d',
    file: 'house-cleaning-resolution-d.mp4',
    dir:  'house-cleaning/shared',
    prompt: `homeowner delighted walking through freshly cleaned Australian home, running finger along spotless surface, smiling with satisfaction, gleaming clean rooms, ${S}`,
  },
  {
    name: 'house-cleaning-resolution-e',
    file: 'house-cleaning-resolution-e.mp4',
    dir:  'house-cleaning/shared',
    prompt: `cleaner and homeowner shaking hands at front door after completed clean, homeowner very happy and giving thumbs up, Australian home, ${S}`,
  },
  {
    name: 'house-cleaning-cta-d',
    file: 'house-cleaning-cta-d.mp4',
    dir:  'house-cleaning/shared',
    prompt: `spotless modern Australian living room with gleaming floors, fresh flowers, everything perfectly organised and clean, bright natural light, welcoming home, ${S}`,
  },
  {
    name: 'house-cleaning-cta-e',
    file: 'house-cleaning-cta-e.mp4',
    dir:  'house-cleaning/shared',
    prompt: `happy Australian family relaxing in beautifully clean home, children playing on clean carpet, parents smiling, fresh and comfortable living environment, ${S}`,
  },

  // ── Greasy rangehood ────────────────────────────────────────────────────────
  {
    name: 'greasy-rangehood-hook-d',
    file: 'greasy-rangehood-hook-d.mp4',
    dir:  'house-cleaning/greasy-rangehood',
    prompt: `thick yellow grease dripping from dirty kitchen exhaust fan filters, grease coating inside the range hood extractor, disgusting close-up, Australian kitchen, ${S}`,
  },
  {
    name: 'greasy-rangehood-hook-e',
    file: 'greasy-rangehood-hook-e.mp4',
    dir:  'house-cleaning/greasy-rangehood',
    prompt: `kitchen exhaust fan not working properly, smoke filling the room while cooking, homeowner waves smoke away frustrated, dirty clogged range hood extractor visible, ${S}`,
  },
  {
    name: 'greasy-rangehood-treatment-c',
    file: 'greasy-rangehood-treatment-c.mp4',
    dir:  'house-cleaning/greasy-rangehood',
    prompt: `professional cleaner soaking greasy range hood extractor filters in degreaser solution, scrubbing with brush, grease dissolving, filters coming out clean and shiny, ${S}`,
  },
  {
    name: 'greasy-rangehood-treatment-d',
    file: 'greasy-rangehood-treatment-d.mp4',
    dir:  'house-cleaning/greasy-rangehood',
    prompt: `cleaner wiping inside of kitchen range hood extractor with degreaser, removing thick grease buildup from fan blades and housing, before and after visible transformation, ${S}`,
  },
  {
    name: 'greasy-rangehood-treatment-e',
    file: 'greasy-rangehood-treatment-e.mp4',
    dir:  'house-cleaning/greasy-rangehood',
    prompt: `clean shiny kitchen exhaust fan filters reinstalled in sparkling range hood extractor, cleaner switching it on and it runs quietly and powerfully, Australian kitchen, ${S}`,
  },

  // ── Dirty bathroom ──────────────────────────────────────────────────────────
  {
    name: 'dirty-bathroom-hook-d',
    file: 'dirty-bathroom-hook-d.mp4',
    dir:  'house-cleaning/dirty-bathroom',
    prompt: `black mould growing on shower grout and silicone, soap scum coating glass shower screen, limescale on taps and showerhead, neglected Australian bathroom close-ups, ${S}`,
  },
  {
    name: 'dirty-bathroom-hook-e',
    file: 'dirty-bathroom-hook-e.mp4',
    dir:  'house-cleaning/dirty-bathroom',
    prompt: `yellow stained toilet bowl with limescale buildup, dirty grout, hair and grime around drain, homeowner looks disgusted, heavily neglected Australian bathroom, ${S}`,
  },
  {
    name: 'dirty-bathroom-treatment-d',
    file: 'dirty-bathroom-treatment-d.mp4',
    dir:  'house-cleaning/dirty-bathroom',
    prompt: `professional cleaner scrubbing black mould from tile grout with stiff brush and bleach solution, wearing gloves, bathroom tiles transforming from black to white, ${S}`,
  },
  {
    name: 'dirty-bathroom-treatment-e',
    file: 'dirty-bathroom-treatment-e.mp4',
    dir:  'house-cleaning/dirty-bathroom',
    prompt: `cleaner polishing chrome taps and showerhead to a shine, cleaning glass shower screen with squeegee, bathroom looking brand new, Australian home, ${S}`,
  },

  // ── End of lease ────────────────────────────────────────────────────────────
  {
    name: 'end-of-lease-hook-d',
    file: 'end-of-lease-hook-d.mp4',
    dir:  'house-cleaning/end-of-lease',
    prompt: `stressed tenant packing boxes in dirty rental property, scuff marks on walls, stained carpet, dirty oven, worried about bond return, Australian rental home, ${S}`,
  },
  {
    name: 'end-of-lease-hook-e',
    file: 'end-of-lease-hook-e.mp4',
    dir:  'house-cleaning/end-of-lease',
    prompt: `property manager or landlord inspecting rental property with checklist clipboard, noting dirty marks and uncleaned areas, concerned expression, Australian rental inspection, ${S}`,
  },
  {
    name: 'end-of-lease-treatment-d',
    file: 'end-of-lease-treatment-d.mp4',
    dir:  'house-cleaning/end-of-lease',
    prompt: `professional end-of-lease cleaner scrubbing oven interior with heavy-duty degreaser, grease and grime coming off, oven looking like new, Australian kitchen, ${S}`,
  },
  {
    name: 'end-of-lease-treatment-e',
    file: 'end-of-lease-treatment-e.mp4',
    dir:  'house-cleaning/end-of-lease',
    prompt: `cleaner steam cleaning carpet stains in empty rental property, stain disappearing under steam, moving systematically through rooms, bond clean in progress, ${S}`,
  },

  // ── Deep clean ──────────────────────────────────────────────────────────────
  {
    name: 'deep-clean-hook-d',
    file: 'deep-clean-hook-d.mp4',
    dir:  'house-cleaning/deep-clean',
    prompt: `dusty ceiling fan blades with thick grey dust, grease-coated rangehood filters, limescale crusted shower screen, neglected Australian home needing deep clean, ${S}`,
  },
  {
    name: 'deep-clean-hook-e',
    file: 'deep-clean-hook-e.mp4',
    dir:  'house-cleaning/deep-clean',
    prompt: `homeowner overwhelmed looking at list of cleaning tasks, cluttered dusty rooms, dirty windows, neglected corners throughout Australian home, ${S}`,
  },
  {
    name: 'deep-clean-treatment-d',
    file: 'deep-clean-treatment-d.mp4',
    dir:  'house-cleaning/deep-clean',
    prompt: `professional cleaner using extension duster to clean ceiling fan blades and light fixtures, dust falling, working systematically through Australian home, ${S}`,
  },
  {
    name: 'deep-clean-treatment-e',
    file: 'deep-clean-treatment-e.mp4',
    dir:  'house-cleaning/deep-clean',
    prompt: `cleaner cleaning inside windows and window tracks with detail brush, removing built-up grime, windows sparkling clean, Australian home looking refreshed, ${S}`,
  },
];

async function main() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
    process.exit(1);
  }

  console.log(`\nRound 8 — ${ALL_CLIPS.length} clips × ${CREDITS_PER_CLIP} credits = ${ALL_CLIPS.length * CREDITS_PER_CLIP} credits`);
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

  // Submit one at a time (Kling limits parallel tasks to 3 on resource pack).
  // Poll each to completion before submitting the next.
  let completed = 0;

  for (const [i, clip] of toGenerate.entries()) {
    console.log(`\n[${i + 1}/${toGenerate.length}] ${clip.name}`);
    process.stdout.write(`  submitting...`);
    let taskId;
    try {
      taskId = await submit(clip.prompt);
      console.log(` → ${taskId}`);
    } catch (err) {
      console.log(` ✗ ${err.message}`);
      continue;
    }

    const url = await pollUntilDone(taskId, clip.name);
    if (!url) { console.log(`  ✗ ${clip.name} — failed or timed out`); continue; }

    const destDir = path.join(CLIPS_ROOT, clip.dir);
    mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, clip.file);
    process.stdout.write(`  downloading ${clip.file}...`);
    console.log(` ${await download(url, destPath)} ✓`);
    completed++;
  }

  console.log(`\n=== Round 8 complete — ${completed}/${toGenerate.length} clips ===`);
  console.log('Next: node src/video/r2-upload.js   (upload new clips)');
  console.log('Then: node src/video/r2-download.js  (sync back to confirm)');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
