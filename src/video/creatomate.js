#!/usr/bin/env node

/**
 * Video renderer — automated video creation from reviews.
 *
 * Default: renders locally via ffmpeg (zero API cost).
 * Pass --api to use Creatomate API instead (requires CREATOMATE_API_KEY).
 *
 * Usage:
 *   node src/video/creatomate.js                     # Render all prompted prospects (local ffmpeg)
 *   node src/video/creatomate.js --limit 5           # Up to 5
 *   node src/video/creatomate.js --id 3              # Specific prospect
 *   node src/video/creatomate.js --dry-run           # Preview without rendering
 *   node src/video/creatomate.js --api               # Use Creatomate API instead of ffmpeg
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import sharp from 'sharp';
import * as musicMetadata from 'music-metadata';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { readFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { buildScenes, pickClipsFromPool } from './shotstack-lib.js';
import { pickMusicTrack } from './music-tracks.js';
import { renderVideo, extractPosterFrame } from './ffmpeg-render.js';
import { pickVariant } from './style-variants.js';

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
    limit: { type: 'string', default: '100' },
    id: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    api: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },  // skip R2, print file:// URI
  },
  strict: false,
});

const USE_API = args.api;

if (USE_API && !API_KEY) {
  console.error('ERROR: CREATOMATE_API_KEY must be set in .env (--api mode)');
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

let api;
if (USE_API) {
  api = axios.create({
    baseURL: 'https://api.creatomate.com/v1',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

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

// ─── Poster image (snapshot + play button) ───────────────────────────────────

/**
 * Download Creatomate snapshot JPEG, resize to 400×711, composite a play button
 * (dark circle + white triangle polygon) over it, upload to R2, return public URL.
 *
 * The play button is baked into the image so email clients receive one <img> tag
 * with no CSS overlay — Outlook-safe.
 */
/**
 * Build poster JPEG with play button overlay from a raw frame buffer.
 * Returns the final JPEG buffer (caller uploads to R2).
 */
async function buildPosterFromBuffer(frameBuf, prospectId) {
  const posterBuf = await sharp(frameBuf)
    .resize(400, null, { fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 85 })
    .toBuffer();

  const { width: W, height: H } = await sharp(posterBuf).metadata();

  const r = 36;
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  const tx = cx + 4;
  const ty = cy;
  const th = 22;
  const tw = 26;
  const p1 = `${tx - Math.round(tw * 0.4)},${ty - th}`;
  const p2 = `${tx - Math.round(tw * 0.4)},${ty + th}`;
  const p3 = `${tx + Math.round(tw * 0.6)},${ty}`;

  const svgOverlay = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(0,0,0,0.62)" />
      <polygon points="${p1} ${p2} ${p3}" fill="white" />
    </svg>`
  );

  return sharp(posterBuf)
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Build poster from a Creatomate snapshot URL (API mode only).
 */
async function buildPosterImage(snapshotUrl, prospectId) {
  const res = await fetch(snapshotUrl);
  if (!res.ok) throw new Error(`Snapshot download failed ${res.status}: ${snapshotUrl}`);
  const frameBuf = Buffer.from(await res.arrayBuffer());
  const posterBuf = await buildPosterFromBuffer(frameBuf, prospectId);
  return uploadToR2(posterBuf, `poster-p${prospectId}.jpg`, 'image/jpeg');
}

// ─── Logo processing ─────────────────────────────────────────────────────────

/**
 * Download logo, optionally add a grey pill backdrop (only if logo has no opaque background),
 * and return a buffer ready for ffmpeg overlay.
 *
 * Logo target: fit within 80% wide × 15% tall of video (864×288px at 1080×1920).
 * Pill: only added when the logo has meaningful transparency (alpha channel with non-opaque pixels).
 *   Opaque logos (JPEG, or PNG with solid white/dark bg) don't need a pill — they bring their own bg.
 *
 * Returns: { buf: Buffer, url: string|null }
 *   - buf: always set (for local ffmpeg)
 *   - url: set only in API mode
 */
async function processLogoWithGlow(logoUrl, prospectId) {
  const res = await fetch(logoUrl);
  if (!res.ok) throw new Error(`Logo download failed ${res.status}: ${logoUrl}`);
  const origBuf = Buffer.from(await res.arrayBuffer());

  // Resize to fit within 864×288 (80% wide, 15% tall at 1080×1920)
  const maxW = 864;
  const maxH = 288;
  const logoBuf = await sharp(origBuf)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

  // Detect whether the logo has meaningful transparency.
  // Sharp's stats() on the alpha channel: if mean alpha < 254, there are transparent pixels.
  const { channels } = await sharp(logoBuf).metadata();
  let hasTransparency = false;
  if (channels === 4) {
    const stats = await sharp(logoBuf).stats();
    const alphaMean = stats.channels[3]?.mean ?? 255;
    hasTransparency = alphaMean < 250; // any meaningful transparency → add pill
  }

  if (!hasTransparency) {
    // Opaque logo — use as-is, no pill needed
    const url = USE_API
      ? await uploadToR2(logoBuf, `logo-glow-p${prospectId}.png`, 'image/png')
      : null;
    return { buf: logoBuf, url };
  }

  // Transparent logo — add grey rounded-rect pill backdrop
  const { width: logoW, height: logoH } = await sharp(logoBuf).metadata();
  const padH = 24;
  const padV = 16;
  const pillW = logoW + padH * 2;
  const pillH = logoH + padV * 2;
  const radius = Math.round(pillH * 0.35);

  const svgPill = Buffer.from(
    `<svg width="${pillW}" height="${pillH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${pillW}" height="${pillH}"
        rx="${radius}" ry="${radius}"
        fill="rgba(110,110,110,0.62)" />
    </svg>`
  );

  const finalBuf = await sharp({
    create: { width: pillW, height: pillH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: svgPill, top: 0, left: 0 },
      { input: logoBuf, top: padV, left: padH },
    ])
    .png()
    .toBuffer();

  const url = USE_API
    ? await uploadToR2(finalBuf, `logo-glow-p${prospectId}.png`, 'image/png')
    : null;

  return { buf: finalBuf, url };
}

// ─── Phone formatter ─────────────────────────────────────────────────────────

function formatPhoneNational(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\s+/g, '');
  // +61XXXXXXXXX → local format
  // 9-digit remainder (mobile/landline): prepend 0 → 10 digits
  // 10-digit remainder (1300/1800): keep as-is (already national)
  const m = digits.match(/^\+61(\d+)$/);
  const remainder = m ? m[1] : null;
  const local = remainder
    ? (remainder.length === 9 ? '0' + remainder : remainder)
    : digits;
  // 10-digit mobile: 04XX XXX XXX
  if (local.length === 10 && local.startsWith('04')) {
    return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
  }
  // 1300 / 1800 / 13XX: XXXX XXX XXX or XXXX XXX XXX
  if (local.length === 10 && (local.startsWith('13') || local.startsWith('18'))) {
    return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
  }
  // 02/03/07/08 landline: 0X XXXX XXXX
  if (local.length === 10) {
    return local.slice(0, 2) + ' ' + local.slice(2, 6) + ' ' + local.slice(6);
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
function buildSource(clips, audioUrls, scenes, logoUrl, phoneText, musicUrl) {
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

  const totalDuration = starts[starts.length - 1] + scenes[scenes.length - 1].duration;

  // ── Track 1: video clips ──
  // loop: "pingpong" plays forward then backward — no visible jump when audio > clip length
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
      loop: true,
    });
  }

  // ── Track 5 (lowest): background music, full video duration, ducked under voiceover ──
  if (musicUrl) {
    elements.push({
      name: 'Music',
      type: 'audio',
      track: 5,
      time: 0,
      duration: totalDuration,
      source: musicUrl,
      volume: '15%',   // quiet background under voiceover
      loop: true,
      audio_fade_out: 1.5,
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
    snapshot_time: 2,  // t=2s is within scene 1 — logo visible
    width: 1080,
    height: 1920,
    elements,
  };
}

// ─── Render ──────────────────────────────────────────────────────────────────

async function submitRender(prospect) {
  const pid = prospect.id;

  const clips = pickClipsFromPool(prospect.niche, pid, prospect.best_review_text || '');
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

  const variant = pickVariant(pid);

  if (args['dry-run']) {
    const music = pickMusicTrack(pid);
    console.log(`  Clips: ${clips.map(c => c.url.split('/').pop()).join(', ')}`);
    console.log(`  Music: ${music.name}`);
    console.log(`  Logo: ${prospect.logo_url || 'none'}`);
    console.log(`  Phone: ${nationalPhone || 'none'}`);
    console.log(`  Style: Variant ${variant.id} (font: ${variant.font.split('/').pop()}, pill: ${variant.boxColor}, transition: ${variant.transition})`);
    console.log(`  Scenes (est): ${scenes.map(s => s.duration + 's').join(' + ')} = ${scenes.reduce((a, b) => a + b.duration, 0)}s`);
    return { id: 'dry-run', status: 'dry-run' };
  }

  // Prepend a short SSML break to scene 1 (first quote, index 1) to reset ElevenLabs
  // prosody after the hook question — prevents rising intonation carrying over.
  const scenesForTTS = scenesForAudio.map((s, i) =>
    i === 1 ? { ...s, voiceover: `<break time="400ms"/>${s.voiceover}` } : s
  );

  process.stdout.write(`  Generating audio (${scenesForTTS.length} scenes)...`);
  const audios = [];
  for (const scene of scenesForTTS) {
    audios.push(await generateAudio(scene.voiceover));
  }
  process.stdout.write(' done\n');

  // Measure actual audio durations and use them (+ 0.4s tail) so nothing gets chopped
  const TAIL_BUFFER = 0.4; // seconds of silence after voiceover ends
  const audioDurations = await Promise.all(audios.map(async (buf) => {
    const meta = await musicMetadata.parseBuffer(buf, { mimeType: 'audio/mpeg' });
    const raw = meta.format.duration ?? 0;
    return Math.ceil((raw + TAIL_BUFFER) * 10) / 10; // round up to nearest 0.1s
  }));

  // Merge measured durations back into scenes (override shotstack defaults)
  const scenesWithDuration = scenes.map((s, i) => ({ ...s, duration: audioDurations[i] }));

  const phoneText = nationalPhone || null;

  // Process logo: add grey glow pill
  let logo = null;
  if (prospect.logo_url) {
    process.stdout.write('  Processing logo...');
    logo = await processLogoWithGlow(prospect.logo_url, pid);
    process.stdout.write(' done\n');
  }

  const music = pickMusicTrack(pid);
  console.log(`  Music: ${music.name}`);

  if (USE_API) {
    // ── Creatomate API path ──
    process.stdout.write('  Uploading audio to R2...');
    const audioUrls = await Promise.all(
      audios.map((buf, i) => uploadToR2(buf, `audio-p${pid}-scene${i + 1}.mp3`))
    );
    process.stdout.write(' done\n');

    const source = buildSource(clips, audioUrls, scenesWithDuration, logo?.url || null, phoneText, music.url);
    const { data } = await api.post('/renders', { source, render_scale: 1 });
    const render = Array.isArray(data) ? data[0] : data;
    return { mode: 'api', render };
  }

  // ── Local ffmpeg path (default) ──
  await mkdir(resolve(root, 'tmp'), { recursive: true });
  const outPath = resolve(root, `tmp/video-p${pid}.mp4`);

  const logoSceneIndices = logo ? [0, clips.length - 1] : [];
  const result = await renderVideo({
    clips,
    audioBufs: audios,
    scenes: scenesWithDuration,
    logoBuf: logo?.buf || null,
    musicUrl: music.url,
    logoSceneIndices,
    outputPath: outPath,
    variant,
  });

  if (args.local) {
    // Skip R2 — just return local file:// URI for quick testing
    return { mode: 'local', videoUrl: `file://${outPath}`, posterUrl: null, duration: result.duration, variantId: variant.id };
  }

  // Upload finished video to R2
  process.stdout.write('  Uploading video to R2...');
  const videoBuf = await readFile(outPath);
  const videoUrl = await uploadToR2(videoBuf, `video-p${pid}.mp4`, 'video/mp4');
  process.stdout.write(' done\n');

  // Extract poster frame and upload
  process.stdout.write('  Building poster image...');
  const posterFrame = await extractPosterFrame(outPath);
  const posterBuf = await buildPosterFromBuffer(posterFrame, pid);
  const posterUrl = await uploadToR2(posterBuf, `poster-p${pid}.jpg`, 'image/jpeg');
  process.stdout.write(' done\n');

  return { mode: 'local', videoUrl, posterUrl, duration: result.duration, variantId: variant.id };
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

  const modeLabel = USE_API ? 'Creatomate API' : 'local ffmpeg';
  console.log(`Rendering ${prospects.length} videos via ${modeLabel}${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  const updateVideo = db.prepare(`UPDATE videos SET status = ?, video_url = ?, thumbnail_url = ?, style_variant = ? WHERE id = ?`);
  let success = 0, failed = 0;

  for (const prospect of prospects) {
    try {
      // Skip pest control prospects with generic reviews (no specific pest detected).
      // These need generic clip sets first — see TODO.md "generic pest clips".
      if (prospect.niche === 'pest control') {
        const { detectPestFromReview } = await import('./shotstack-lib.js');
        const pest = detectPestFromReview(prospect.best_review_text || '');
        if (!pest) {
          console.log(`[${prospect.id}] ${prospect.business_name} — SKIP (generic review, no pest detected)`);
          continue;
        }
      }

      console.log(`[${prospect.id}] ${prospect.business_name} (${prospect.city})...`);
      const result = await submitRender(prospect);

      if (args['dry-run']) { success++; continue; }

      if (result.mode === 'api') {
        // Creatomate API path
        console.log(`  Render submitted (${result.render.id}), waiting for completion`);
        updateVideo.run('rendering', null, null, null, prospect.video_id);
        const completed = await pollRender(result.render.id);
        console.log(`\n  ✓ Video ready: ${completed.url}`);
        process.stdout.write('  Building poster image...');
        const posterUrl = await buildPosterImage(completed.snapshot_url, prospect.id);
        process.stdout.write(' done\n');
        console.log(`  Poster: ${posterUrl}`);
        updateVideo.run('completed', completed.url, posterUrl, null, prospect.video_id);
      } else {
        // Local ffmpeg path
        console.log(`  ✓ Video ready: ${result.videoUrl} [variant ${result.variantId}]`);
        if (result.posterUrl) console.log(`  Poster: ${result.posterUrl}`);
        if (!args.local) {
          updateVideo.run('completed', result.videoUrl, result.posterUrl, result.variantId, prospect.video_id);
        }
      }
      db.prepare('UPDATE prospects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('video_created', prospect.id);
      success++;
    } catch (err) {
      console.error(`\n  ✗ Failed: ${err.message}`);
      updateVideo.run('failed', null, null, null, prospect.video_id);
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
