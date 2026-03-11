#!/usr/bin/env node

/**
 * Shotstack video renderer — generates review promo videos via Shotstack Edit API.
 *
 * Pipeline per prospect:
 *   1. Build voiceover script from review text
 *   2. Generate MP3 via ElevenLabs API
 *   3. Upload MP3 to Shotstack ingest (→ hosted URL)
 *   4. Fetch video clips — curated pool first, Pexels search fallback
 *   5. Submit render to Shotstack Edit API
 *   6. Poll until done, save video URL to DB
 *
 * Usage:
 *   node src/video/shotstack.js                 # Process all video_prompted prospects
 *   node src/video/shotstack.js --limit 3       # Up to 3
 *   node src/video/shotstack.js --id 14         # Specific prospect
 *   node src/video/shotstack.js --dry-run       # Print payload, skip render
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
// Pure functions live in shotstack-lib.js (also imported by tests)
import {
  buildVoiceoverScript,
  buildSceneTexts,
  buildRenderPayload,
  pickClipsFromPool,
  PEXELS_FALLBACK_QUERIES,
} from './shotstack-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');

// ─── Config ──────────────────────────────────────────────────────────────────

const SHOTSTACK_KEY = process.env.SHOTSTACK_API_KEY;
const SHOTSTACK_ENV = process.env.SHOTSTACK_ENV || 'stage';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const PEXELS_KEY = process.env.PEXELS_API_KEY;

// Charlie — only AU accent in ElevenLabs premade set
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'IKne3meq5aSn9XLyUdCD';

const SHOTSTACK_BASE = `https://api.shotstack.io/edit/${SHOTSTACK_ENV}`;
const SHOTSTACK_INGEST = `https://api.shotstack.io/ingest/${SHOTSTACK_ENV}`;

const { values: args } = parseArgs({
  options: {
    limit:     { type: 'string',  default: '10' },
    id:        { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!SHOTSTACK_KEY) { console.error('ERROR: SHOTSTACK_API_KEY must be set'); process.exit(1); }
if (!ELEVENLABS_KEY) { console.error('ERROR: ELEVENLABS_API_KEY must be set'); process.exit(1); }
if (!PEXELS_KEY) { console.error('ERROR: PEXELS_API_KEY must be set'); process.exit(1); }

// ─── HTTP clients ─────────────────────────────────────────────────────────────

const shotstack = axios.create({
  baseURL: SHOTSTACK_BASE,
  headers: { 'x-api-key': SHOTSTACK_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const shotstackIngest = axios.create({
  baseURL: SHOTSTACK_INGEST,
  headers: { 'x-api-key': SHOTSTACK_KEY, 'Accept': 'application/json' },
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
      WHERE p.id = ? AND v.video_tool = 'shotstack' AND v.status = 'prompted'
    `).all(parseInt(args.id, 10));
  }
  return db.prepare(`
    SELECT p.*, v.id as video_id, v.prompt_text
    FROM prospects p
    JOIN videos v ON v.prospect_id = p.id
    WHERE v.video_tool = 'shotstack' AND v.status = 'prompted'
    ORDER BY p.google_rating DESC, p.review_count DESC
    LIMIT ?
  `).all(parseInt(args.limit, 10));
}

// ─── ElevenLabs voiceover ─────────────────────────────────────────────────────

async function generateVoiceover(script) {
  console.log('  Generating voiceover via ElevenLabs...');

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: script,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );

  return Buffer.from(response.data);
}

// ─── Shotstack asset upload ───────────────────────────────────────────────────

async function uploadAudioToShotstack(audioBuffer) {
  console.log('  Uploading audio to Shotstack...');

  const { data: uploadData } = await shotstackIngest.post('/upload');
  const signedUrl = uploadData.data.attributes.url;
  const sourceId = uploadData.data.id;

  // CRITICAL: do NOT include Content-Type — it breaks the AWS S3 signature.
  const putRes = await fetch(signedUrl, { method: 'PUT', body: audioBuffer });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Shotstack S3 upload failed ${putRes.status}: ${body.substring(0, 200)}`);
  }

  return pollIngestSource(sourceId);
}

async function pollIngestSource(sourceId, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { data } = await shotstackIngest.get(`/sources/${sourceId}`);
    const { status, source: url } = data.data.attributes;
    if (status === 'ready') return url;
    if (status === 'failed') throw new Error(`Shotstack ingest failed for source ${sourceId}`);
    await sleep(2000);
  }
  throw new Error('Shotstack ingest timed out');
}

// ─── Pexels clip fetcher (fallback) ──────────────────────────────────────────

const pexelsCache = new Map();

async function fetchPexelsClip(query, seed = 0) {
  const cacheKey = `${query}:${seed}`;
  if (pexelsCache.has(cacheKey)) return pexelsCache.get(cacheKey);

  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=portrait&size=medium`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
  const data = await res.json();

  const usable = (data.videos || []).filter(v => v.duration >= 5 && v.duration <= 25);
  if (!usable.length) return null;

  const pick = usable[seed % usable.length];
  const file =
    pick.video_files.find(f => f.width === 720 && f.height === 1280) ||
    pick.video_files.find(f => f.height > f.width && f.quality === 'hd') ||
    pick.video_files.find(f => f.height > f.width) ||
    pick.video_files[0];

  const clipUrl = file?.link || null;
  pexelsCache.set(cacheKey, clipUrl);
  return clipUrl;
}

async function fetchClips(niche, seed = 0) {
  // Try curated pool first
  const poolClips = pickClipsFromPool(niche, seed);
  if (poolClips) {
    console.log('  Using curated clip pool.');
    return poolClips;
  }

  // Fall back to Pexels search
  console.log('  Clip pool empty — using Pexels search fallback.');
  const queries = PEXELS_FALLBACK_QUERIES[niche] || PEXELS_FALLBACK_QUERIES.default;
  const clips = await Promise.all(queries.map((q, i) => fetchPexelsClip(q, seed + i)));

  return Promise.all(clips.map(async (c, i) => {
    if (c) return c;
    console.warn(`  Clip ${i + 1} missing, using generic fallback`);
    return fetchPexelsClip('home interior clean', seed);
  }));
}

// ─── Shotstack render + poll ──────────────────────────────────────────────────

async function submitRender(payload) {
  try {
    const { data } = await shotstack.post('/render', payload);
    return data.response.id;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Shotstack render submit failed: ${detail}`);
  }
}

async function pollRender(renderId, maxWaitMs = 300000) {
  const start = Date.now();
  process.stdout.write('  Rendering');
  while (Date.now() - start < maxWaitMs) {
    await sleep(6000);
    const { data } = await shotstack.get(`/render/${renderId}`);
    const { status, url } = data.response;
    if (status === 'done') { process.stdout.write(' ✓\n'); return url; }
    if (status === 'failed') {
      process.stdout.write(' ✗\n');
      throw new Error(`Render failed: ${data.response.error || 'unknown'}`);
    }
    process.stdout.write('.');
  }
  throw new Error(`Render timed out after ${maxWaitMs / 1000}s`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function processProspect(prospect, updateVideo) {
  const name = prospect.business_name.split('|')[0].trim();
  console.log(`\n[${prospect.id}] ${name}`);

  const voiceoverScript = buildVoiceoverScript(prospect);
  const scenes = buildSceneTexts(prospect);
  console.log(`  Script: ${voiceoverScript.length} chars`);

  const clips = await fetchClips(prospect.niche || 'default', prospect.id || 0);
  const audioBuffer = await generateVoiceover(voiceoverScript);
  console.log(`  Audio: ${Math.round(audioBuffer.length / 1024)}KB`);

  // Fetch logo if available
  const logoUrl = prospect.logo_url || null;
  if (logoUrl) console.log(`  Logo: ${logoUrl}`);

  if (args['dry-run']) {
    const payload = buildRenderPayload(clips, 'DRY_RUN_AUDIO_URL', scenes, logoUrl);
    console.log('  Payload:', JSON.stringify(payload, null, 2));
    return;
  }

  const audioUrl = await uploadAudioToShotstack(audioBuffer);
  console.log(`  Audio hosted: ${audioUrl}`);

  const payload = buildRenderPayload(clips, audioUrl, scenes, logoUrl);
  updateVideo.run('rendering', null, prospect.video_id);

  const renderId = await submitRender(payload);
  console.log(`  Render submitted: ${renderId}`);

  const videoUrl = await pollRender(renderId);
  console.log(`  Video ready: ${videoUrl}`);

  updateVideo.run('completed', videoUrl, prospect.video_id);
  db.prepare('UPDATE prospects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('video_created', prospect.id);
}

async function main() {
  const prospects = getProspects();

  if (prospects.length === 0) {
    console.log('No prospects with shotstack videos in "prompted" status.');
    console.log('Run: node src/video/prompt-generator.js --tool shotstack');
    return;
  }

  console.log(`Rendering ${prospects.length} videos via Shotstack${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  const updateVideo = db.prepare('UPDATE videos SET status = ?, video_url = ? WHERE id = ?');
  let success = 0;
  let failed = 0;

  for (const prospect of prospects) {
    try {
      await processProspect(prospect, updateVideo);
      success++;
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      if (prospect.video_id) updateVideo.run('failed', null, prospect.video_id);
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
