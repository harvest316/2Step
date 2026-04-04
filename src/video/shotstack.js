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
import axios from 'axios';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { existsSync, readFileSync } from 'fs';
import { getAll, run } from '../utils/db.js';
// execSync no longer needed — Opus called via OpenRouter API
// Pure functions live in scene-builder.js (also imported by tests)
import {
  buildScenes,
  buildVoiceoverScript,
  buildSceneTexts,
  buildRenderPayload,
  pickClipsFromPool,
  sceneDuration,
  timingsToSceneDurations,
  applyPhonetics,
} from './scene-builder.js';
import { logLLMUsage } from '../utils/log-llm-usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

// ─── Config ──────────────────────────────────────────────────────────────────

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = 'anthropic/claude-opus-4';

const SHOTSTACK_KEY = process.env.SHOTSTACK_API_KEY;
const SHOTSTACK_ENV = process.env.SHOTSTACK_ENV || 'stage';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

// Charlie — only AU accent in ElevenLabs premade set
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'IKne3meq5aSn9XLyUdCD';

const SHOTSTACK_BASE = `https://api.shotstack.io/edit/${SHOTSTACK_ENV}`;

// ─── ElevenLabs pronunciation dictionary ──────────────────────────────────────
// Created by: node src/video/pronunciation-dict.js create
// If not found, falls back to the inline applyPhonetics() text substitution.
const DICT_CACHE_PATH = resolve(root, '.pronunciation-dict.json');
const pronunciationDictLocators = (() => {
  if (!existsSync(DICT_CACHE_PATH)) return [];
  try {
    const { id, version_id } = JSON.parse(readFileSync(DICT_CACHE_PATH, 'utf8'));
    if (!id) return [];
    console.log(`  Pronunciation dictionary: ${id}`);
    return [{ pronunciation_dictionary_id: id, version_id }];
  } catch { return []; }
})();
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

async function getSites() {
  if (args.id) {
    return await getAll(
      `SELECT s.*, v.id as video_id, v.prompt_text
       FROM sites s
       JOIN videos v ON v.site_id = s.id
       WHERE s.id = $1 AND v.video_tool = 'shotstack' AND v.status = 'prompted'`,
      [parseInt(args.id, 10)]
    );
  }
  return await getAll(
    `SELECT s.*, v.id as video_id, v.prompt_text
     FROM sites s
     JOIN videos v ON v.site_id = s.id
     WHERE v.video_tool = 'shotstack' AND v.status = 'prompted'
     ORDER BY s.google_rating DESC, s.review_count DESC
     LIMIT $1`,
    [parseInt(args.limit, 10)]
  );
}

// ─── ElevenLabs voiceover ─────────────────────────────────────────────────────

/**
 * Generate voiceover via ElevenLabs with word-level timestamps.
 * Uses the `/with-timestamps` endpoint which returns JSON containing
 * base64-encoded audio AND character-level alignment data.
 *
 * @param {string} script
 * @returns {{ audioBuffer: Buffer, alignment: object }}
 */
async function generateVoiceover(script) {
  console.log('  Generating voiceover via ElevenLabs (with timestamps)...');

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/with-timestamps`,
    {
      text: script,
      model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true,
      },
      // Server-side alias substitution for Australian suburb names.
      // Populated by: node src/video/pronunciation-dict.js create
      // Falls back gracefully to inline applyPhonetics() if dict not created yet.
      ...(pronunciationDictLocators.length
        ? { pronunciation_dictionary_locators: pronunciationDictLocators }
        : {}),
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 30000,
    }
  );

  const { audio_base64, alignment } = response.data;
  const audioBuffer = Buffer.from(audio_base64, 'base64');
  return { audioBuffer, alignment };
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

async function fetchClips(niche, seed = 0) {
  const poolClips = pickClipsFromPool(niche, seed);
  if (poolClips) {
    console.log('  Using curated clip pool.');
    return poolClips;
  }
  throw new Error(`No curated clips available for niche "${niche}" — add clips to the pool in scene-builder.js`);
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
    if (status === 'done') { process.stdout.write(' done\n'); return url; }
    if (status === 'failed') {
      process.stdout.write(' failed\n');
      throw new Error(`Render failed: ${data.response.error || 'unknown'}`);
    }
    process.stdout.write('.');
  }
  throw new Error(`Render timed out after ${maxWaitMs / 1000}s`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Opus scene generator ─────────────────────────────────────────────────────

/**
 * Use Claude Opus to generate polished scene voiceovers and screen text.
 * Falls back to buildScenes() if Opus call fails.
 *
 * @param {{ business_name, city, best_review_author, best_review_text }} prospect
 * @returns {Array<{ text: string, voiceover: string, duration: number }>}
 */
async function buildScenesWithOpus(prospect) {
  const name = prospect.business_name.split('|')[0].trim();
  const city = prospect.city || 'Sydney';
  const reviewer = prospect.best_review_author || 'a customer';
  const review = prospect.best_review_text || '';
  const phone = prospect.phone || null;

  // Look up known phonetic form so Opus uses it in every scene, not just scene 1.
  const cityPhonetic = applyPhonetics(city, city);
  const phoneticHint = cityPhonetic !== city
    ? `\nPhonetic form for "${city}" in voiceover: "${cityPhonetic}" — use this every time the suburb is mentioned`
    : '';

  const phoneHint = phone
    ? `\nPhone: ${phone} — include this in scene 5 text and voiceover`
    : '';

  const ctaTextExample = phone
    ? `"Name\\nCall ${phone}"`
    : `"Name\\nCity | Book Now"`;
  const ctaVoiceExample = phone
    ? `"\\"Name\\" — call us on ${phone}."`
    : `"\\"Name\\" — trusted by locals in City. Book your service today."`;

  const prompt = `You are writing copy for a 20-second social media video ad for a local business.

Business: ${name}
City: ${city}${phoneticHint}${phoneHint}
Reviewer: ${reviewer}
Review: "${review}"

Generate exactly 5 scenes as a JSON array. Each scene has:
- "voiceover": what the narrator says out loud — must convey the SAME meaning as the on-screen text
- "text": what appears on screen — NO quotes around the business name, short and punchy, max 2 lines, max 60 chars per line

Scene structure:
1. Hook: grab attention, mention business name and city
2. Quote part 1: a short punchy excerpt from the review (<=15 words, complete sentence or phrase)
3. Quote part 2: a different short excerpt from the review (<=15 words, must differ from scene 2)
4. Attribution: five stars, reviewer name
5. CTA: call to action, business name, phone number (if provided)

Rules:
- The voiceover for each scene must say the same thing as the on-screen text — a viewer reading the text should hear the same words spoken. Do NOT paraphrase or substitute synonyms.
- Wrap the business name in "double quotes" in voiceover ONLY (not in text) to help TTS pronounce it as a proper noun
- If the business name already contains the city name, do not repeat the city in the same sentence
- Keep voiceover natural and conversational — avoid corporate language
- Scene 2 and 3 MUST use different quotes from the review
- For unusual place names that TTS will mispronounce, use a phonetic respelling in the voiceover field only. The text field always uses the correct spelling. Apply the phonetic form consistently in EVERY scene where the suburb name appears — not just scene 1. Example: write "Wah-ROON-ga" instead of "Wahroonga", "AR-tar-mon" instead of "Artarmon".
- Return ONLY valid JSON, no markdown, no explanation

Example output format:
[
  {"voiceover": "Why \\"Wahroonga\\" locals trust \\"Name\\".", "text": "Why Wahroonga Locals\\nTrust Name"},
  {"voiceover": "Absolutely fantastic from start to finish.", "text": "\\"Absolutely fantastic\\nfrom start to finish.\\""},
  {"voiceover": "He went above and beyond every time.", "text": "\\"He went above\\nand beyond every time.\\""},
  {"voiceover": "Five stars — from Jane Smith.", "text": "stars\\n— Jane Smith"},
  {"voiceover": ${ctaVoiceExample}, "text": ${ctaTextExample}}
]`;

  try {
    if (!OPENROUTER_KEY) throw new Error('No OPENROUTER_API_KEY set');

    const headers = { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' };

    const res = await fetch(`${OPENROUTER_BASE}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text.substring(0, 200)}`);
    }
    const data = await res.json();
    logLLMUsage({ stage: 'video', provider: 'openrouter', model: OPENROUTER_MODEL, promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens }).catch(() => {});
    const raw = data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? '';
    if (!raw) throw new Error('Empty response from API');

    // Strip any markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed) || parsed.length !== 5) throw new Error('Expected 5-element array');
    for (const s of parsed) {
      if (typeof s.voiceover !== 'string' || typeof s.text !== 'string') throw new Error('Invalid scene shape');
    }

    // Derive durations from voiceover length (same logic as buildScenes)
    const fullScript = parsed.map(s => s.voiceover).join('  ');
    const rawDurs = parsed.map(s => Math.max(3, sceneDuration(s.voiceover)));
    const totalEstimated = rawDurs.reduce((a, b) => a + b, 0);
    const fullDuration = sceneDuration(fullScript) + 3;
    const scale = fullDuration / totalEstimated;

    const suburb = prospect.suburb || prospect.city || '';
    console.log('  Using Opus-generated scenes.');
    return parsed.map((s, i) => ({
      text: s.text,
      // Post-process: enforce consistent phonetic suburb pronunciation regardless
      // of whether Opus applied it to every scene (it sometimes misses scene 5).
      voiceover: applyPhonetics(s.voiceover, suburb),
      duration: Math.max(3, Math.round(rawDurs[i] * scale)),
    }));
  } catch (err) {
    console.warn(`  Opus scene generation failed (${err.message}) — falling back to template.`);
    return buildScenes(prospect);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Royalty-free background music — must be a publicly accessible URL (hosted on R2 or similar).
// Download a free track from e.g. pixabay.com/music, upload to R2, then set this env var.
// Leave unset to render without background music.
const MUSIC_URL = process.env.BACKGROUND_MUSIC_URL || null;

async function processProspect(prospect) {
  const name = prospect.business_name.split('|')[0].trim();
  console.log(`\n[${prospect.id}] ${name}`);

  const scenes = await buildScenesWithOpus(prospect);
  const voiceoverScript = buildVoiceoverScript(scenes);
  console.log(`  Script: ${voiceoverScript.length} chars`);

  const clips = await fetchClips(prospect.niche || 'default', prospect.id || 0);

  // Generate voiceover with timestamps — use alignment to set exact scene durations
  const { audioBuffer, alignment } = await generateVoiceover(voiceoverScript);
  console.log(`  Audio: ${Math.round(audioBuffer.length / 1024)}KB`);

  // Replace estimated durations with exact measured durations from alignment
  const exactDurs = timingsToSceneDurations(scenes, voiceoverScript, alignment);
  const timedScenes = scenes.map((s, i) => ({ ...s, duration: exactDurs[i] }));
  const sceneTexts = buildSceneTexts(timedScenes);
  const totalDuration = timedScenes.reduce((s, sc) => s + sc.duration, 0);
  console.log(`  Exact durations: [${exactDurs.join(', ')}]s = ${totalDuration}s total`);

  // Fetch logo if available
  const logoUrl = prospect.logo_url || null;
  if (logoUrl) console.log(`  Logo: ${logoUrl}`);

  if (args['dry-run']) {
    const payload = buildRenderPayload(clips, 'DRY_RUN_AUDIO_URL', sceneTexts, logoUrl, MUSIC_URL);
    console.log('  Payload:', JSON.stringify(payload, null, 2));
    return;
  }

  const audioUrl = await uploadAudioToShotstack(audioBuffer);
  console.log(`  Audio hosted: ${audioUrl}`);

  const payload = buildRenderPayload(clips, audioUrl, sceneTexts, logoUrl, MUSIC_URL);
  await run('UPDATE videos SET status = $1, video_url = $2 WHERE id = $3', ['rendering', null, prospect.video_id]);

  const renderId = await submitRender(payload);
  console.log(`  Render submitted: ${renderId}`);

  const videoUrl = await pollRender(renderId);
  console.log(`  Video ready: ${videoUrl}`);

  await run('UPDATE videos SET status = $1, video_url = $2 WHERE id = $3', ['completed', videoUrl, prospect.video_id]);
  await run('UPDATE sites SET status = $1, updated_at = NOW() WHERE id = $2', ['video_created', prospect.id]);
}

async function main() {
  const sites = await getSites();

  if (sites.length === 0) {
    console.log('No sites with shotstack videos in "prompted" status.');
    console.log('Run: node src/video/prompt-generator.js --tool shotstack');
    return;
  }

  console.log(`Rendering ${sites.length} videos via Shotstack${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  let success = 0;
  let failed = 0;

  for (const site of sites) {
    try {
      await processProspect(site);
      success++;
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      if (site.video_id) {
        await run('UPDATE videos SET status = $1, video_url = $2 WHERE id = $3', ['failed', null, site.video_id]);
      }
      failed++;
    }
  }

  console.log(`\nDone: ${success} rendered, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
