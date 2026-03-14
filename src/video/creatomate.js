#!/usr/bin/env node

/**
 * Creatomate API video renderer — automated video creation from reviews.
 *
 * Flat track layout (no compositions — those broke positioning + transcript sync).
 *
 *   Track 1: video clips (one per scene, sequential)
 *   Track 2: voiceover audio (one per scene, sequential)
 *   Track 3: RSVP subtitles (transcript_source → audio id)
 *   Track 4: logo image (scenes 1 + 5)
 *   Track 5: phone text (scene 5 only)
 *
 * Usage:
 *   node src/video/creatomate.js                     # Process all video_prompted prospects
 *   node src/video/creatomate.js --limit 5           # Up to 5
 *   node src/video/creatomate.js --id 3              # Specific prospect
 *   node src/video/creatomate.js --dry-run           # Preview without rendering
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import sharp from 'sharp';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { randomUUID } from 'crypto';
import { buildScenes, pickClipsFromPool } from './shotstack-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const API_KEY = process.env.CREATOMATE_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'IKne3meq5aSn9XLyUdCD';
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '10' },
    id: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!API_KEY) {
  console.error('ERROR: CREATOMATE_API_KEY must be set in .env');
  process.exit(1);
}
if (!ELEVENLABS_KEY) {
  console.error('ERROR: ELEVENLABS_API_KEY must be set in .env');
  process.exit(1);
}
if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !R2_BUCKET) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BUCKET_NAME must be set in .env');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://api.creatomate.com/v1',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function getProspects() {
  if (args.id) {
    return db.prepare(`
      SELECT p.*, v.id as video_id, v.prompt_text
      FROM prospects p
      JOIN videos v ON v.prospect_id = p.id
      WHERE p.id = ? AND v.video_tool = 'creatomate' AND v.status = 'prompted'
    `).all(parseInt(args.id, 10));
  }

  return db.prepare(`
    SELECT p.*, v.id as video_id, v.prompt_text
    FROM prospects p
    JOIN videos v ON v.prospect_id = p.id
    WHERE v.video_tool = 'creatomate'
      AND v.status = 'prompted'
    ORDER BY p.google_rating DESC
    LIMIT ?
  `).all(parseInt(args.limit, 10));
}

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function generateAudio(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.75, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── R2 Upload ───────────────────────────────────────────────────────────────

async function uploadToR2(buffer, key, contentType = 'audio/mpeg') {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`R2 upload failed ${res.status}: ${(await res.text()).substring(0, 200)}`);
  return `${R2_PUBLIC_URL}/${key}`;
}

// ─── Logo processing ─────────────────────────────────────────────────────────

/**
 * Download logo, add a mid-grey semi-transparent rounded pill behind it,
 * upload to R2, return public URL. Result cached per prospect so we don't
 * reprocess on every render.
 *
 * Video is 720×1280. Logo target: ~90% wide (648px), max ~20% tall (256px).
 * Pill padding: 24px H / 20px V around the resized logo.
 */
async function processLogoWithGlow(logoUrl, prospectId) {
  const key = `logo-glow-p${prospectId}.png`;

  // Download original logo
  const res = await fetch(logoUrl);
  if (!res.ok) throw new Error(`Logo download failed ${res.status}: ${logoUrl}`);
  const origBuf = Buffer.from(await res.arrayBuffer());

  // Resize to fit within 648×256, preserving aspect ratio
  const maxW = 648;
  const maxH = 256;
  const logoBuf = await sharp(origBuf)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

  const { width: logoW, height: logoH } = await sharp(logoBuf).metadata();

  const padH = 28;  // horizontal padding each side
  const padV = 18;  // vertical padding each side
  const pillW = logoW + padH * 2;
  const pillH = logoH + padV * 2;
  const radius = Math.round(pillH * 0.35); // ~35% radius for pill shape

  // Build SVG rounded rect as grey backdrop
  const svgPill = Buffer.from(
    `<svg width="${pillW}" height="${pillH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${pillW}" height="${pillH}"
        rx="${radius}" ry="${radius}"
        fill="rgba(110,110,110,0.62)" />
    </svg>`
  );

  // Composite: pill behind, logo on top centred
  const finalBuf = await sharp({
    create: { width: pillW, height: pillH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: svgPill, top: 0, left: 0 },
      { input: logoBuf, top: padV, left: padH },
    ])
    .png()
    .toBuffer();

  return uploadToR2(finalBuf, key, 'image/png');
}

// ─── Phone formatter ─────────────────────────────────────────────────────────

function formatPhoneNational(phone) {
  if (!phone) return phone;
  const m = phone.replace(/\s+/g, '').match(/^\+61(\d+)$/);
  if (!m) return phone;
  const local = '0' + m[1];
  if (local.length === 10) {
    return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
  }
  return local;
}

/**
 * Format phone for TTS voiceover — spells out digits with pauses so ElevenLabs
 * reads "zero four one two" instead of "zoe four one two".
 * Input: national format like "0412 931 208"
 */
function formatPhoneTTS(phone) {
  if (!phone) return phone;
  const digitWords = { '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine' };
  // Split into groups by spaces, spell each digit within a group, join groups with comma-pause
  return phone.split(' ').map(group =>
    group.split('').map(d => digitWords[d] || d).join(' ')
  ).join(', ');
}

// ─── Build flat source JSON ──────────────────────────────────────────────────

/**
 * Build Creatomate source as flat tracks (no compositions).
 * All elements at top level with explicit time + duration.
 */
function buildSource(clips, audioUrls, scenes, logoUrl, phoneText) {
  const elements = [];

  // Compute cumulative start times from scene durations
  const starts = [];
  let t = 0;
  for (const scene of scenes) {
    starts.push(t);
    t += scene.duration;
  }

  // Assign a UUID to each audio element so transcript_source can reference it
  const audioIds = scenes.map(() => randomUUID());

  // ── Track 1: video clips ──
  for (let i = 0; i < clips.length; i++) {
    elements.push({
      name: `Clip-${i + 1}`,
      type: 'video',
      track: 1,
      time: starts[i],
      duration: scenes[i].duration,
      source: clips[i].url,
      volume: 0,
      fit: 'cover',
    });
  }

  // ── Track 2: voiceover audio ──
  for (let i = 0; i < audioUrls.length; i++) {
    elements.push({
      id: audioIds[i],
      name: `Voiceover-${i + 1}`,
      type: 'audio',
      track: 2,
      time: starts[i],
      duration: scenes[i].duration,
      source: audioUrls[i],
    });
  }

  // ── Track 3: text overlays (static scene text, matches voiceover content) ──
  for (let i = 0; i < scenes.length; i++) {
    // Place text opposite logo: if logo is top (subtitle focus=top), text goes bottom
    const textY = clips[i]?.focus === 'top' ? '8%' : '80%';
    const textVAlign = clips[i]?.focus === 'top' ? '0%' : '50%';
    elements.push({
      name: `Text-${i + 1}`,
      type: 'text',
      track: 3,
      time: starts[i],
      duration: scenes[i].duration,
      text: scenes[i].text,
      y: textY,
      width: '85%',
      height: '15%',
      x_alignment: '50%',
      y_alignment: textVAlign,
      fill_color: '#ffffff',
      font_family: 'Montserrat',
      font_weight: '800',
      stroke_color: '#000000',
      stroke_width: '1.5 vmin',
      font_size_maximum: '7 vmin',
      background_color: 'rgba(0,0,0,0.5)',
      background_border_radius: '1.5%',
      background_x_padding: '3%',
      background_y_padding: '2%',
    });
  }

  // ── Track 4: logo on scene 1 (hook) and scene 5 (cta) ──
  // Logo is pre-processed with grey pill baked in (via sharp). Width ~90% of video.
  // Logo goes opposite the text: text at bottom → logo at top, text at top → logo at bottom.
  if (logoUrl) {
    for (const idx of [0, clips.length - 1]) {
      const logoY = clips[idx]?.focus === 'top' ? '88%' : '8%';
      elements.push({
        name: `Logo-${idx + 1}`,
        type: 'image',
        track: 4,
        time: starts[idx],
        duration: scenes[idx].duration,
        source: logoUrl,
        y: logoY,
        width: '90%',
        x_alignment: '50%',
        y_alignment: '50%',
        fit: 'contain',
      });
    }
  }

  return {
    output_format: 'mp4',
    width: 720,
    height: 1280,
    elements,
  };
}

// ─── Render ──────────────────────────────────────────────────────────────────

async function submitRender(prospect) {
  const pid = prospect.id;

  const clips = pickClipsFromPool(prospect.niche, pid);
  if (!clips) throw new Error(`No clips available for niche "${prospect.niche}"`);

  // Format phone to national AU before buildScenes so CTA text shows "Call 0412 931 208"
  const nationalPhone = formatPhoneNational(prospect.phone);
  const prospectForScenes = { ...prospect, phone: nationalPhone };
  const scenes = buildScenes(prospectForScenes);

  // For TTS, replace national phone with spelled-out digits ("zero four one two...")
  // so ElevenLabs doesn't mispronounce "0" as "zoe"
  const ttsPhone = formatPhoneTTS(nationalPhone);
  const scenesForAudio = ttsPhone && nationalPhone
    ? scenes.map(s => ({ ...s, voiceover: s.voiceover.replace(nationalPhone, ttsPhone) }))
    : scenes;

  process.stdout.write('  Generating audio (5 scenes)...');
  const audios = [];
  for (const scene of scenesForAudio) {
    audios.push(await generateAudio(scene.voiceover));
  }
  process.stdout.write(' done\n');

  process.stdout.write('  Uploading audio to R2...');
  const audioUrls = await Promise.all(
    audios.map((buf, i) => uploadToR2(buf, `audio-p${pid}-scene${i + 1}.mp3`))
  );
  process.stdout.write(' done\n');

  const phoneText = nationalPhone || null;

  // Process logo: add grey glow pill, upload to R2
  let logoUrl = null;
  if (prospect.logo_url) {
    process.stdout.write('  Processing logo...');
    logoUrl = await processLogoWithGlow(prospect.logo_url, pid);
    process.stdout.write(' done\n');
  }

  const source = buildSource(clips, audioUrls, scenes, logoUrl, phoneText);

  if (args['dry-run']) {
    console.log(`  Clips: ${clips.map(c => c.url.split('/').pop()).join(', ')}`);
    console.log(`  Logo: ${prospect.logo_url || 'none'}`);
    console.log(`  Phone: ${phoneText || 'none'}`);
    console.log(`  Scenes: ${scenes.map(s => s.duration + 's').join(' + ')} = ${scenes.reduce((a,b) => a+b.duration, 0)}s`);
    console.log(`  Source:\n${JSON.stringify(source, null, 2)}`);
    return { id: 'dry-run', status: 'dry-run' };
  }

  const { data } = await api.post('/renders', { source });
  const render = Array.isArray(data) ? data[0] : data;
  return render;
}

async function pollRender(renderId, maxWaitMs = 300000) {
  const start = Date.now();
  const pollInterval = 5000;

  while (Date.now() - start < maxWaitMs) {
    const { data } = await api.get(`/renders/${renderId}`);
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed') throw new Error(`Render failed: ${data.error_message || 'unknown error'}`);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error(`Render timed out after ${maxWaitMs / 1000}s`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const prospects = getProspects();

  if (prospects.length === 0) {
    console.log('No prospects with creatomate videos in "prompted" status.');
    console.log('Use: node src/video/prompt-generator.js --tool creatomate');
    return;
  }

  console.log(`Rendering ${prospects.length} videos via Creatomate${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  const updateVideo = db.prepare(`UPDATE videos SET status = ?, video_url = ? WHERE id = ?`);
  let success = 0, failed = 0;

  for (const prospect of prospects) {
    try {
      console.log(`[${prospect.id}] ${prospect.business_name} (${prospect.city})...`);
      const render = await submitRender(prospect);

      if (args['dry-run']) { success++; continue; }

      console.log(`  Render submitted (${render.id}), waiting for completion`);
      updateVideo.run('rendering', null, prospect.video_id);

      const completed = await pollRender(render.id);
      console.log(`\n  ✓ Video ready: ${completed.url}`);
      updateVideo.run('completed', completed.url, prospect.video_id);
      db.prepare('UPDATE prospects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('video_created', prospect.id);
      success++;
    } catch (err) {
      console.error(`\n  ✗ Failed: ${err.message}`);
      updateVideo.run('failed', null, prospect.video_id);
      failed++;
    }
  }

  db.close();
  console.log(`\nDone: ${success} rendered, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
