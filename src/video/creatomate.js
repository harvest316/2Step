#!/usr/bin/env node

/**
 * @deprecated This standalone renderer is superseded by src/stages/video.js
 * which integrates into the pipeline (enriched -> video_created) and uses
 * the shared db.js connection with ATTACH'd messages DB. This file remains
 * for reference and one-off re-renders but should not be used for new
 * pipeline work. The buildPosterFromBuffer and extractPosterFrame logic
 * has been incorporated into stages/video.js directly.
 *
 * Video renderer — automated video creation from reviews via local ffmpeg.
 *
 * Usage:
 *   node src/video/creatomate.js                     # Render all prompted prospects
 *   node src/video/creatomate.js --limit 5           # Up to 5
 *   node src/video/creatomate.js --id 3              # Specific prospect
 *   node src/video/creatomate.js --dry-run           # Preview without rendering
 *   node src/video/creatomate.js --local             # Skip R2 upload, print file:// URI
 */

import '../utils/load-env.js';
import sharp from 'sharp';
import * as musicMetadata from 'music-metadata';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { readFile, mkdir } from 'fs/promises';
import { buildScenes, pickClipsFromPool } from './shotstack-lib.js';
import { pickMusicTrack } from './music-tracks.js';
import { renderVideo, extractPosterFrame } from './ffmpeg-render.js';
import { pickVariant } from './style-variants.js';
import db from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
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
    local: { type: 'boolean', default: false },  // skip R2, print file:// URI
  },
  strict: false,
});

if (!ELEVENLABS_KEY) {
  console.error('ERROR: ELEVENLABS_API_KEY must be set in .env');
  process.exit(1);
}
if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !R2_BUCKET) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BUCKET_NAME must be set in .env');
  process.exit(1);
}

// ─── Database ────────────────────────────────────────────────────────────────

function getSites() {
  if (args.id) {
    return db.prepare(`
      SELECT s.*, v.id as video_id, v.prompt_text
      FROM sites s
      JOIN videos v ON v.site_id = s.id
      WHERE s.id = ? AND v.video_tool = 'creatomate' AND v.status = 'prompted'
    `).all(parseInt(args.id, 10));
  }

  return db.prepare(`
    SELECT s.*, v.id as video_id, v.prompt_text
    FROM sites s
    JOIN videos v ON v.site_id = s.id
    WHERE v.video_tool = 'creatomate'
      AND v.status = 'prompted'
    ORDER BY s.google_rating DESC
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

  // Resize to fit within 972×384 (90% wide, 20% tall at 1080×1920), maintaining aspect ratio
  const maxW = 972;
  const maxH = 384;
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
    return { buf: logoBuf, url: null };
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

  const url = null; // logo uploaded only if needed for API mode (not currently used)

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

  // Process logo: add grey glow pill
  let logo = null;
  if (prospect.logo_url) {
    process.stdout.write('  Processing logo...');
    logo = await processLogoWithGlow(prospect.logo_url, pid);
    process.stdout.write(' done\n');
  }

  const music = pickMusicTrack(pid);
  console.log(`  Music: ${music.name}`);

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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sites = getSites();

  if (sites.length === 0) {
    console.log('No sites with video_tool="creatomate" in "prompted" status.');
    console.log('Use: node src/video/prompt-generator.js --tool creatomate');
    return;
  }

  console.log(`Rendering ${sites.length} videos via local ffmpeg${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  const updateVideo = db.prepare(`UPDATE videos SET status = ?, video_url = ?, thumbnail_url = ?, style_variant = ? WHERE id = ?`);
  let success = 0, failed = 0;

  for (const site of sites) {
    try {
      if (!site.phone && !site.email && !site.instagram_handle && !site.facebook_page_url) {
        console.log(`[${site.id}] ${site.business_name} — SKIP (no contact method)`);
        updateVideo.run('failed', null, null, null, site.video_id);
        failed++;
        continue;
      }

      if (site.niche === 'pest control') {
        const { detectPestFromReview } = await import('./shotstack-lib.js');
        const pest = detectPestFromReview(site.best_review_text || '');
        if (!pest) {
          console.log(`[${site.id}] ${site.business_name} — SKIP (generic review, no pest detected)`);
          continue;
        }
      }

      console.log(`[${site.id}] ${site.business_name} (${site.city})...`);
      const result = await submitRender(site);

      if (args['dry-run']) { success++; continue; }

      console.log(`  ✓ Video ready: ${result.videoUrl} [variant ${result.variantId}]`);
      if (result.posterUrl) console.log(`  Poster: ${result.posterUrl}`);
      if (!args.local) {
        updateVideo.run('completed', result.videoUrl, result.posterUrl, result.variantId, site.video_id);
      }
      db.prepare('UPDATE sites SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('video_created', site.id);
      success++;
    } catch (err) {
      console.error(`\n  ✗ Failed: ${err.message}`);
      updateVideo.run('failed', null, null, null, site.video_id);
      failed++;
    }
  }

  console.log(`\nDone: ${success} rendered, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
