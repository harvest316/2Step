#!/usr/bin/env node

/**
 * Video creation pipeline stage for 2Step.
 *
 * Takes sites at status='enriched' (with logo_url set) and produces a 30s
 * AI video from their best review using local ffmpeg rendering.
 *
 * Pipeline per site:
 *   1. Parse selected_review_json for review text + author
 *   2. Build 7-scene script from the review (hook → quotes → stars → CTA)
 *   3. Generate ElevenLabs voiceover per scene (with pronunciation dict if available)
 *   4. Pick clips from pool by problem_category (deterministic, seed = site_id)
 *   5. Call ffmpeg-render.js to assemble the video
 *   6. Upload final MP4 to Cloudflare R2
 *   7. Store base62 video_hash, insert videos row, update site status
 *
 * Usage:
 *   node src/stages/video.js                # Process all eligible sites
 *   node src/stages/video.js --limit 5      # Up to 5 sites
 *   node src/stages/video.js --id 8         # Specific site by ID
 *   node src/stages/video.js --dry-run      # Print plan, skip render/upload
 *   node src/stages/video.js --local        # Render locally, skip R2 upload, print file:// URI
 */

import '../utils/load-env.js';
import { getAll, run, withTransaction } from '../utils/db.js';
import { provisionVideoReview } from './provision-portal.js';
import { renderVideo, extractPosterFrame } from '../video/ffmpeg-render.js';
import {
  buildScenes,
  pickClipsFromPool,
  timingsToSceneDurations,
  extractQuotes,
  smoothGrammar,
  businessName,
} from '../video/scene-builder.js';
import { gatherPronunciation, generatePLS } from '../video/pronunciation-sources.js';
import { getVoiceId } from '../video/elevenlabs-voices.js';
import { pickMusicTrack } from '../video/music-tracks.js';
import { pickVariant } from '../video/style-variants.js';
import sharp from 'sharp';
import { mkdir, rm, readFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ─── Config ───────────────────────────────────────────────────────────────────

const ELEVENLABS_KEY      = process.env.ELEVENLABS_API_KEY;
const EL_BASE             = 'https://api.elevenlabs.io/v1';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET     = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

const DICT_CACHE_PATH = resolve(ROOT, '.pronunciation-dict.json');
const PLS_DICT_IDS_PATH = resolve(ROOT, 'data/pronunciation/.pls-dict-ids.json');

// ─── Base62 hash ──────────────────────────────────────────────────────────────

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(num) {
  if (num === 0) return BASE62_CHARS[0];
  let result = '';
  let n = num;
  while (n > 0) {
    result = BASE62_CHARS[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

// ─── ElevenLabs pronunciation dictionary ─────────────────────────────────────

// New: per-country PLS phoneme dicts (CMU ARPAbet on eleven_turbo_v2)
const plsDictIds = (() => {
  if (!existsSync(PLS_DICT_IDS_PATH)) return {};
  try { return JSON.parse(readFileSync(PLS_DICT_IDS_PATH)); } catch { return {}; }
})();

// Legacy: single alias dict (fallback if no PLS dict for country)
const legacyDictLocators = (() => {
  if (!existsSync(DICT_CACHE_PATH)) return [];
  try {
    const { id, version_id } = JSON.parse(readFileSync(DICT_CACHE_PATH));
    if (!id) return [];
    return [{ pronunciation_dictionary_id: id, version_id }];
  } catch { return []; }
})();

function getDictLocators(countryCode) {
  if (!countryCode) throw new Error('country_code is required for dictionary lookup');
  const cc = countryCode.toUpperCase();
  const entry = plsDictIds[cc];
  if (entry?.id) {
    return [{ pronunciation_dictionary_id: entry.id, version_id: entry.version_id }];
  }
  return legacyDictLocators; // fallback to alias dict
}

// Track which place names are in the current PLS (loaded at startup)
const _plsGraphemes = new Set();
for (const cc of Object.keys(plsDictIds)) {
  const plsPath = resolve(ROOT, `data/pronunciation/${cc.toLowerCase()}.pls`);
  if (existsSync(plsPath)) {
    const pls = readFileSync(plsPath, 'utf8');
    for (const match of pls.matchAll(/<grapheme>([^<]+)<\/grapheme>/g)) {
      _plsGraphemes.add(`${cc}:${match[1].toLowerCase()}`);
    }
  }
}

/**
 * Ensure a place name has a pronunciation in the PLS before rendering.
 * If not found, gathers pronunciation from all sources (including Opus researcher)
 * and re-uploads the PLS to ElevenLabs.
 */
async function ensurePronunciation(city, countryCode, state) {
  if (!city) return;
  if (!countryCode) throw new Error('country_code is required for pronunciation lookup');
  const cc = countryCode.toUpperCase();
  const key = `${cc}:${city.toLowerCase()}`;

  if (_plsGraphemes.has(key)) return; // already in PLS

  process.stdout.write(`  Pronunciation lookup: ${city} (${cc})... `);

  const result = await gatherPronunciation(city, cc, state, { skipResearch: false });

  if (!result.cmu) {
    console.log('not found — using ElevenLabs default');
    return;
  }

  console.log(`${result.cmu} [${result.confidence}, ${result.agreementCount} sources]`);

  // Append to PLS file and re-upload
  const plsPath = resolve(ROOT, `data/pronunciation/${cc.toLowerCase()}.pls`);
  const resultsPath = resolve(ROOT, `data/pronunciation/results/${cc.toLowerCase()}.json`);

  // Append to results JSON
  let results = [];
  if (existsSync(resultsPath)) {
    try { results = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch { /* */ }
  }
  results.push(result);
  const { mkdirSync } = await import('fs');
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  // Regenerate PLS
  const pls = generatePLS(results);
  writeFileSync(plsPath, pls);

  // Re-upload to ElevenLabs
  try {
    const form = new FormData();
    form.append('name', `2step-${cc.toLowerCase()}-${Date.now()}`);
    form.append('file', new Blob([pls], { type: 'text/xml' }), `${cc.toLowerCase()}.pls`);
    const res = await fetch(`${EL_BASE}/pronunciation-dictionaries/add-from-file`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY },
      body: form,
    });
    if (res.ok) {
      const dict = await res.json();
      plsDictIds[cc] = { id: dict.id, version_id: dict.version_id, uploaded_at: new Date().toISOString(), entry_count: dict.version_rules_num };
      writeFileSync(PLS_DICT_IDS_PATH, JSON.stringify(plsDictIds, null, 2));
      console.log(`  PLS re-uploaded: ${dict.version_rules_num} rules`);
    }
  } catch (e) {
    console.warn(`  PLS upload failed: ${e.message}`);
  }

  _plsGraphemes.add(key);
}

// ─── ElevenLabs voiceover generation ─────────────────────────────────────────

/* c8 ignore start — ElevenLabs API + R2 upload + ffmpeg render I/O */
/**
 * Generate a single MP3 audio buffer for a voiceover string via ElevenLabs.
 * Uses the /with-timestamps endpoint so we get alignment data for scene timing.
 *
 * @param {string} text  — the voiceover string to synthesise
 * @returns {Promise<{ audioBuf: Buffer, alignment: object }>}
 */
async function generateVoiceover(text, countryCode) {
  const dictLocators = getDictLocators(countryCode);
  const body = {
    text,
    model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2',
    voice_settings: { stability: 0.6, similarity_boost: 0.8 },
    ...(dictLocators.length
      ? { pronunciation_dictionary_locators: dictLocators }
      : {}),
  };

  const voiceId = getVoiceId(countryCode);
  const res = await fetch(
    `${EL_BASE}/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs TTS failed ${res.status}: ${text.substring(0, 300)}`);
  }

  const json = await res.json();
  // Response shape: { audio_base64: string, alignment: { characters, ... } }
  const audioBuf = Buffer.from(json.audio_base64, 'base64');
  return { audioBuf, alignment: json.alignment };
}

/**
 * Generate per-scene audio buffers and compute scene durations from alignment data.
 *
 * Generates one TTS call per scene (rather than a single concatenated call) so we
 * get clean per-scene timing without the double-space separator heuristic.
 *
 * @param {Array<{ voiceover: string }>} scenes
 * @param {string|null} suburb  — for phonetic substitution fallback
 * @returns {Promise<{ audioBufs: Buffer[], durations: number[] }>}
 */
async function generateSceneAudio(scenes, suburb = null, countryCode) {
  if (!countryCode) throw new Error('country_code is required for audio generation');
  const audioBufs = [];
  const durations = [];

  for (const scene of scenes) {
    const voiceover = scene.voiceover;

    const { audioBuf, alignment } = await generateVoiceover(voiceover, countryCode);
    audioBufs.push(audioBuf);

    // Derive duration from alignment end time + 0.5s tail
    const endTimes = alignment?.character_end_times_seconds;
    if (endTimes && endTimes.length > 0) {
      const lastEnd = endTimes[endTimes.length - 1];
      durations.push(Math.max(2, Math.round((lastEnd + 0.5) * 10) / 10));
    } else {
      // Fallback: estimate from word count at 180 wpm
      const words = voiceover.trim().split(/\s+/).length;
      durations.push(Math.max(2, Math.ceil(words / 180 * 60) + 1));
    }
  }

  return { audioBufs, durations };
}

// ─── Script proofreading via LLM ─────────────────────────────────────────────

const PROOFREAD_PROMPT = readFileSync(
  resolve(ROOT, 'prompts/PROOFREAD-SCRIPT.md'), 'utf8',
);

/**
 * Run an LLM proofreading pass over a 7-scene script via `claude -p`.
 * Returns the scenes with voiceover fixes applied. If the LLM flags
 * quotes for replacement, logs a warning but continues (manual review needed).
 *
 * @param {Array<{ text: string, voiceover: string }>} scenes
 * @param {string} fullReview — the full review text (for re-extracting quotes)
 * @returns {Promise<Array<{ text: string, voiceover: string }>>} — scenes with VO fixes applied
 */
async function proofreadScript(scenes, fullReview) {
  const scriptData = scenes.map((s, i) => ({
    scene: i + 1,
    label: ['HOOK', 'Q1', 'Q2', 'Q3', 'Q4', 'STARS', 'CTA'][i],
    text: s.text,
    voiceover: s.voiceover,
  }));

  const fullPrompt = `${PROOFREAD_PROMPT}

Proofread this 7-scene video script.

<untrusted_content>
${JSON.stringify(scriptData, null, 2)}
</untrusted_content>`;

  process.stdout.write('  Proofreading script...');

  let content;
  try {
    const { stdout, stderr } = await execFileAsync('claude', ['-p', fullPrompt], {
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    });
    if (stderr) console.warn(`  Proofreader stderr: ${stderr.slice(0, 200)}`);
    content = stdout.trim();
  } catch (e) {
    console.warn(` LLM proofread failed: ${e.message} — using unproofed script`);
    return scenes;
  }

  let result;
  try {
    // Strip markdown fences if present
    const cleaned = content.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
    result = JSON.parse(cleaned);
  } catch {
    console.warn(` LLM returned unparseable JSON — using unproofed script`);
    return scenes;
  }

  // Apply VO fixes
  if (result.vo_fixes?.length) {
    for (const fix of result.vo_fixes) {
      const idx = fix.scene - 1;
      if (idx >= 1 && idx <= 4 && scenes[idx]) {
        scenes[idx].voiceover = fix.fixed;
        process.stdout.write(` [Q${idx} VO fixed]`);
      }
    }
  }

  // Log replacement flags (manual action needed)
  if (result.replace_quotes?.length) {
    for (const rq of result.replace_quotes) {
      console.warn(`\n  LLM suggests replacing scene ${rq.scene}: ${rq.reason}`);
    }
  }

  if (result.decision === 'approve') {
    process.stdout.write(' approved\n');
  } else {
    process.stdout.write(` (${result.decision})\n`);
  }

  if (result.notes) console.log(`  Proofreader note: ${result.notes}`);

  return scenes;
}

// ─── R2 upload ────────────────────────────────────────────────────────────────

/**
 * Upload a local file to Cloudflare R2 and return its public URL.
 * @param {string} localPath
 * @param {string} key  — object key (filename) in R2
 * @returns {Promise<string>}  public URL
 */
async function uploadToR2(localPath, key) {
  const body = await readFile(localPath);
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'video/mp4',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed ${res.status}: ${text.substring(0, 200)}`);
  }
  return `${PUBLIC_URL}/${key}`;
}

/**
 * Upload a buffer to Cloudflare R2 and return its public URL.
 * @param {Buffer} buffer
 * @param {string} key  — object key (filename) in R2
 * @param {string} contentType
 * @returns {Promise<string>}  public URL
 */
async function uploadBufferToR2(buffer, key, contentType = 'image/jpeg') {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 poster upload failed ${res.status}: ${text.substring(0, 200)}`);
  }
  return `${PUBLIC_URL}/${key}`;
}

/**
 * Build a poster JPEG with play button overlay from a raw frame buffer.
 * Resizes to 561px wide (matches email template max-width), JPEG quality 80.
 * Composites a dark circle + white triangle play button in the centre.
 * Returns the final JPEG buffer.
 */
async function buildPosterFromBuffer(frameBuf) {
  const posterBuf = await sharp(frameBuf)
    .resize(561, null, { fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 80 })
    .toBuffer();

  const { width: W, height: H } = await sharp(posterBuf).metadata();

  const r = Math.round(W * 0.09);   // ~50px at 561w (was 36 at 400w)
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  const tx = cx + Math.round(r * 0.1);
  const ty = cy;
  const th = Math.round(r * 0.6);
  const tw = Math.round(r * 0.72);
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
    .jpeg({ quality: 80 })
    .toBuffer();
}

// ─── Logo download ────────────────────────────────────────────────────────────

/**
 * Download a logo URL to a buffer, or return null if missing/failed.
 * @param {string|null} url
 * @returns {Promise<Buffer|null>}
 */
async function fetchLogoBuf(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/* c8 ignore stop */

// ─── Landing page publishing ──────────────────────────────────────────────────

const WEBSITE_API = `${process.env.BRAND_URL}/api.php?action=store-video`;
const WEBSITE_SECRET = process.env.API_WORKER_SECRET;

/**
 * Publish video metadata to the auditandfix.com landing page (/v/{hash}).
 * Calls the store-video API to create data/videos/{hash}.json on Hostinger.
 * Non-fatal — logs a warning if it fails (video still works, page just won't load).
 */
async function publishVideoData({ hash, video_url, poster_url, business_name, city, country_code, niche, google_rating, review_count }) {
  if (!WEBSITE_SECRET) {
    console.warn('  API_WORKER_SECRET not set — skipping landing page publish');
    return;
  }

  // Clean the business name the same way the voiceover does
  const countriesMap = await loadCountriesMap();
  const stateAbbrs = countriesMap[country_code] ?? [];
  const cleanName = businessName(business_name, stateAbbrs);

  const nicheDisplay = (niche || '')
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  try {
    const res = await fetch(WEBSITE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Secret': WEBSITE_SECRET,
      },
      body: JSON.stringify({
        hash, video_url, poster_url,
        business_name: cleanName,
        city, country_code, niche,
        niche_display: nicheDisplay,
        google_rating, review_count,
      }),
    });
    if (res.ok) {
      console.log(`  Published landing page: /v/${hash}`);
    } else {
      const body = await res.text();
      console.warn(`  Landing page publish failed ${res.status}: ${body.substring(0, 200)}`);
    }
  } catch (err) {
    console.warn(`  Landing page publish error: ${err.message}`);
  }
}

// ─── Countries helpers ────────────────────────────────────────────────────────

/**
 * Load a map of country_code → state_abbreviations[] from the countries table.
 * Returns {} gracefully if the table doesn't exist yet (pre-migration).
 * @returns {Promise<Record<string, string[]>>}
 */
async function loadCountriesMap() {
  try {
    const rows = await getAll(
      `SELECT country_code, state_abbreviations FROM countries WHERE is_active = 1`
    );
    const map = {};
    for (const row of rows) {
      try {
        map[row.country_code] = JSON.parse(row.state_abbreviations || '[]');
      } catch {
        map[row.country_code] = [];
      }
    }
    return map;
  } catch {
    // countries table not yet migrated — degrade gracefully
    return {};
  }
}

// ─── Main per-site processing ─────────────────────────────────────────────────

/**
 * Process a single site through the video creation pipeline.
 * @param {object} site  — row from sites table
 * @param {object} opts  — { dryRun: boolean }
 * @returns {Promise<{ videoUrl: string, posterUrl: string, videoHash: string, videoId: number, durationSeconds: number, costUsd: number }>}
 */
export async function processSite(site, { dryRun, localOnly = false, stateAbbreviations = [] }) {
  const siteId = site.id;

  // 1. Parse selected_review_json
  let review = null;
  if (site.selected_review_json) {
    try {
      review = typeof site.selected_review_json === 'string'
        ? JSON.parse(site.selected_review_json)
        : site.selected_review_json;
    } catch {
      throw new Error('selected_review_json is not valid JSON');
    }
  }

  // Build a prospect-shaped object compatible with scene-builder helpers
  const prospect = {
    business_name:      site.business_name,
    city:               site.city || 'Sydney',
    niche:              site.niche || 'pest control',
    problem_category:   site.problem_category || null,
    best_review_author: review?.author_name || review?.author || site.best_review_author || 'A Customer',
    best_review_text:   review?.text || review?.review_text || site.best_review_text || '',
    google_rating:      review?.rating ?? site.google_rating ?? 5,
    phone:              site.phone || null,
    logo_url:           site.logo_url || null,
    country_code:       site.country_code || null,
  };

  if (!prospect.best_review_text) {
    throw new Error('No review text available (selected_review_json has no text field and best_review_text is empty)');
  }

  // 2. Build scene script (7 scenes: hook, Q1-Q4, stars, cta)
  let scenes = buildScenes(prospect, { stateAbbreviations });

  // 2b. LLM proofreading — fix VO grammar, flag bad quotes
  scenes = await proofreadScript(scenes, prospect.best_review_text);

  // 3. Pick clips from pool using problem_category or niche
  const poolKey = site.problem_category || prospect.niche;
  const reviewText = prospect.best_review_text;
  // Seed = site_id * 0 per spec (review_index=0, pre-payment), meaning seed = site_id mod pool
  const reviewerName = prospect.best_review_author || '';
  const clips = pickClipsFromPool(poolKey, siteId, reviewText, reviewerName);

  if (!clips) {
    throw new Error(
      `No clips available for problem_category="${site.problem_category}" niche="${prospect.niche}". ` +
      `Add clips to the pool or set problem_category to a known value.`,
    );
  }

  // 4. Pick music and style variant (deterministic by site_id)
  const musicTrack = pickMusicTrack(siteId);
  const variant    = pickVariant(siteId);

  if (dryRun) {
    console.log(`  [dry-run] Would render video for site ${siteId} "${site.business_name}"`);
    console.log(`    Problem: ${site.problem_category || prospect.niche}`);
    console.log(`    Clips: ${clips.map(c => c.url.split('/').pop()).join(', ')}`);
    console.log(`    Music: ${musicTrack.name}  Variant: ${variant.id}`);
    console.log(`    Scenes: ${scenes.length} (7 expected)`);
    return null;
  }

  /* c8 ignore start — live render path: ElevenLabs + ffmpeg + R2 I/O */

  // 4b. On-the-fly pronunciation check — ensure city is in PLS before rendering
  await ensurePronunciation(prospect.city, prospect.country_code, site.state);

  // 5. Generate ElevenLabs voiceover per scene
  if (!ELEVENLABS_KEY) throw new Error('ELEVENLABS_API_KEY must be set');
  process.stdout.write('  Generating voiceovers');
  const { audioBufs, durations } = await generateSceneAudio(scenes, prospect.city, prospect.country_code);
  process.stdout.write(` (${durations.length} scenes)\n`);

  // Attach measured durations back to scenes
  for (let i = 0; i < scenes.length; i++) {
    scenes[i].duration = durations[i] ?? scenes[i].duration;
  }

  const totalDuration = scenes.reduce((s, sc) => s + sc.duration, 0);

  // 6. Download logo
  const logoBuf = await fetchLogoBuf(prospect.logo_url);

  // Logo shows on scene 0 (hook) and last scene (CTA)
  const logoSceneIndices = logoBuf ? [0, scenes.length - 1] : [];

  // 7. Render video with ffmpeg
  const tmpDir    = resolve(ROOT, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const outputPath = resolve(tmpDir, `video-s${siteId}.mp4`);

  const { duration: renderedDuration } = await renderVideo({
    clips,
    audioBufs,
    scenes,
    logoBuf,
    musicUrl: musicTrack.url,
    logoSceneIndices,
    outputPath,
    variant,
  });

  // 8. Upload to R2 (skip in --local mode)
  let videoUrl, posterUrl;
  if (localOnly) {
    videoUrl  = `file://${outputPath}`;
    posterUrl = null;
    console.log(`  Local render: ${videoUrl}`);
    return { videoUrl, posterUrl, videoHash: null, videoId: null, durationSeconds: Math.round(renderedDuration), costUsd: 0 };
  }

  if (!ACCOUNT_ID || !API_TOKEN || !BUCKET || !PUBLIC_URL) {
    throw new Error('Cloudflare R2 env vars not set (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BUCKET_NAME, R2_PUBLIC_URL)');
  }
  const r2Key = `video-s${siteId}-${Date.now()}.mp4`;
  process.stdout.write(`  Uploading to R2 (${r2Key})...`);
  videoUrl = await uploadToR2(outputPath, r2Key);
  process.stdout.write(' done\n');

  // 9. Extract poster frame, build poster image with play button, upload to R2
  // Target midpoint of scene 0, backed off by the outgoing transition duration so
  // we always land in the clean portion of the first slide before the xfade begins.
  const scene0Duration = scenes[0]?.duration ?? 4;
  const td = variant.transitionDuration ?? 0;
  const safeWindow = scene0Duration - td;          // time before xfade starts
  const posterTime = Math.max(0.5, safeWindow / 2); // midpoint of safe window, min 0.5s
  process.stdout.write(`  Building poster image (t=${posterTime.toFixed(2)}s)...`);
  const posterFrame = await extractPosterFrame(outputPath, posterTime);
  const posterBuf = await buildPosterFromBuffer(posterFrame);
  const posterKey = `poster-s${siteId}-${Date.now()}.jpg`;
  posterUrl = await uploadBufferToR2(posterBuf, posterKey, 'image/jpeg');
  process.stdout.write(` done (${posterKey})\n`);

  // 10. Compute base62 hash from site_id
  const videoHash = toBase62(siteId);

  // 11. Write to DB (insert videos row with thumbnail_url, update site)
  const videoId = await withTransaction(async (client) => {
    const insertResult = await client.query(
      `INSERT INTO videos (site_id, video_tool, video_url, thumbnail_url, status, style_variant, music_track, duration_seconds, cost_usd)
       VALUES ($1, 'ffmpeg', $2, $3, 'completed', $4, $5, $6, 0)
       RETURNING id`,
      [siteId, videoUrl, posterUrl, variant.id, musicTrack.name, Math.round(renderedDuration)]
    );
    const newVideoId = insertResult.rows[0].id;
    await client.query(
      `UPDATE sites
       SET video_url  = $1,
           video_hash = $2,
           video_id   = $3,
           status     = 'video_created',
           updated_at = NOW()
       WHERE id = $4`,
      [videoUrl, videoHash, newVideoId, siteId]
    );
    return newVideoId;
  });

  // 12. Publish video data to landing page (/v/{hash})
  await publishVideoData({
    hash: videoHash,
    video_url: videoUrl,
    poster_url: posterUrl,
    business_name: site.business_name,
    city: site.city,
    country_code: site.country_code,
    niche: site.niche,
    google_rating: site.google_rating,
    review_count: site.review_count,
  });

  // 13. Provision video on the customer portal (non-fatal)
  await provisionVideoReview(site, { videoHash, videoUrl, posterUrl }).catch(err =>
    console.warn('[provision-portal] failed (non-fatal):', err.message)
  );

  // Clean up local render file
  await rm(outputPath, { force: true }).catch(() => {});

  return {
    videoUrl,
    posterUrl,
    videoHash,
    videoId,
    durationSeconds: Math.round(renderedDuration),
    costUsd: 0,
  };
  /* c8 ignore stop */
}

// ─── runVideoStage ────────────────────────────────────────────────────────────

/**
 * Run the video creation stage.
 *
 * @param {object} [options]
 * @param {number} [options.limit=50]      Max sites to process
 * @param {number} [options.siteId]        Process only this site ID (any status)
 * @param {boolean} [options.dryRun=false] Print plan, skip render/upload
 * @param {boolean} [options.localOnly=false] Skip R2 upload, print file:// URI
 * @returns {Promise<{ processed: number, created: number, errors: number }>}
 */
export async function runVideoStage(options = {}) {
  const limit     = options.limit     ?? 50;
  const dryRun    = options.dryRun    ?? false;
  const localOnly = options.localOnly ?? false;
  const siteId    = options.siteId    ?? null;

  const sites = siteId
    ? await getAll(
        `SELECT id, business_name, city, niche, phone, email, domain, country_code,
                best_review_text, best_review_author, google_rating, review_count,
                logo_url, selected_review_json, problem_category,
                status, video_url
         FROM sites WHERE id = $1`,
        [siteId]
      )
    : await getAll(
        `SELECT id, business_name, city, niche, phone, email, domain, country_code,
                best_review_text, best_review_author, google_rating, review_count,
                logo_url, selected_review_json, problem_category,
                status, video_url
         FROM sites
         WHERE status IN ('enriched', 'proposals_drafted', 'video_created')
           AND logo_url IS NOT NULL
           AND (phone IS NOT NULL OR email IS NOT NULL)
         ORDER BY id
         LIMIT $1`,
        [limit]
      );

  // Load country state abbreviations once for the whole batch
  const countriesMap = await loadCountriesMap();

  if (sites.length === 0) {
    console.log('No enriched sites with logo_url. Nothing to do.');
    return { processed: 0, created: 0, errors: 0 };
  }

  /* c8 ignore start — per-site processing loop: requires ElevenLabs + ffmpeg + R2 */
  console.log(`Video stage: ${sites.length} site(s) to process${dryRun ? ' [dry-run]' : ''}\n`);

  let created = 0;
  let errors  = 0;

  for (const site of sites) {
    process.stdout.write(`[${site.id}] ${site.business_name} (${site.city || 'unknown'})...\n`);

    try {
      const stateAbbreviations = countriesMap[site.country_code] ?? [];
      const result = await processSite(site, { dryRun, localOnly, stateAbbreviations });

      if (result) {
        console.log(
          `  Created video (hash=${result.videoHash}, ${result.durationSeconds}s) -> ${result.videoUrl}`,
        );
        if (result.posterUrl) console.log(`    Poster: ${result.posterUrl}`);
        created++;
      } else {
        // dry-run — not an error
        created++;
      }
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      await run(
        `UPDATE sites SET error_message = $1, updated_at = NOW() WHERE id = $2`,
        [err.message, site.id]
      );
      errors++;
    }
  }

  console.log(`\nDone: ${created} created, ${errors} errors`);
  return { processed: sites.length, created, errors };
  /* c8 ignore stop */
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

// ── Test-visible exports for pure helper functions ───────────────────────

export { toBase62, buildPosterFromBuffer };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

/* c8 ignore start — CLI entry point */
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      limit:     { type: 'string',  default: '50' },
      id:        { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      local:     { type: 'boolean', default: false },
    },
    strict: false,
  });

  runVideoStage({
    limit:     parseInt(args.limit, 10),
    siteId:    args.id ? parseInt(args.id, 10) : null,
    dryRun:    args['dry-run'],
    localOnly: args.local,
  }).catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
/* c8 ignore stop */
