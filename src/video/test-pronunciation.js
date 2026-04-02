#!/usr/bin/env node

/**
 * Generate reference pronunciation audio for Australian suburb names.
 *
 * TWO modes:
 *   1. ElevenLabs mode (default) — generates audio WITH and WITHOUT the alias dictionary
 *      so you can A/B compare and verify the alias is working correctly.
 *   2. Google Cloud TTS mode (--google) — uses en-AU-Neural2-D voice which has
 *      Google Maps-grade accuracy for Australian place names. Use this when you
 *      don't yet know the correct pronunciation to write as an alias.
 *
 * Usage:
 *   node src/video/test-pronunciation.js Wahroonga
 *   node src/video/test-pronunciation.js "Point Piper"
 *   node src/video/test-pronunciation.js --google Wahroonga   # needs GOOGLE_TTS_KEY
 *   node src/video/test-pronunciation.js --all                # test all suburbs in dict
 *
 * Output: /tmp/pronunciation/<SuburbName>-{raw,alias,google}.mp3
 * Then: xdg-open /tmp/pronunciation/
 */

import '../utils/load-env.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DICT_CACHE_PATH = resolve(ROOT, '.pronunciation-dict.json');

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'IKne3meq5aSn9XLyUdCD';
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_API_KEY; // optional
const OUT_DIR = '/tmp/pronunciation';

const { values: args, positionals } = parseArgs({
  options: {
    google: { type: 'boolean', default: false },
    all:    { type: 'boolean', default: false },
  },
  allowPositionals: true,
  strict: false,
});

// ─── ElevenLabs ───────────────────────────────────────────────────────────────

async function elevenLabsTTS(text, label, locators = []) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}),
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Google Cloud TTS ─────────────────────────────────────────────────────────
//
// Setup: https://cloud.google.com/text-to-speech/docs/quickstart-client-libraries
//   1. Create a Google Cloud project
//   2. Enable the Text-to-Speech API
//   3. Create an API key (or use a service account)
//   4. Add to .env: GOOGLE_TTS_API_KEY=your_key
//   Free tier: 1M Neural2 characters/month — 50 suburbs × 20 chars = 1000 chars total, essentially free.

async function googleTTS(text, voiceName = 'en-AU-Neural2-D') {
  if (!GOOGLE_TTS_KEY) {
    throw new Error('GOOGLE_TTS_API_KEY not set. See setup instructions in test-pronunciation.js');
  }
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'en-AU', name: voiceName },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    }
  );
  if (!res.ok) throw new Error(`Google TTS ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Buffer.from(data.audioContent, 'base64');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function testSuburb(suburb) {
  const slug = suburb.replace(/ /g, '_');
  const script = `This is ${suburb}.`;

  mkdirSync(OUT_DIR, { recursive: true });

  // Load dict locators if available
  const locators = [];
  if (existsSync(DICT_CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(DICT_CACHE_PATH, 'utf8'));
    locators.push({ pronunciation_dictionary_id: cached.id, version_id: cached.version_id });
  }

  console.log(`\nTesting: "${suburb}"`);
  console.log(`Script: "${script}"`);

  if (args.google) {
    process.stdout.write('  Google TTS en-AU-Neural2-D... ');
    try {
      const buf = await googleTTS(script);
      const path = `${OUT_DIR}/${slug}-google.mp3`;
      writeFileSync(path, buf);
      console.log(`✓  ${path}`);
    } catch (e) { console.log(`✗  ${e.message}`); }
  } else {
    // ElevenLabs raw (no dict)
    process.stdout.write('  ElevenLabs raw (no alias)... ');
    try {
      const buf = await elevenLabsTTS(script, 'raw', []);
      const path = `${OUT_DIR}/${slug}-raw.mp3`;
      writeFileSync(path, buf);
      console.log(`✓  ${path}`);
    } catch (e) { console.log(`✗  ${e.message}`); }

    await new Promise(r => setTimeout(r, 400));

    // ElevenLabs with dictionary
    if (locators.length) {
      process.stdout.write('  ElevenLabs with alias dict... ');
      try {
        const buf = await elevenLabsTTS(script, 'alias', locators);
        const path = `${OUT_DIR}/${slug}-alias.mp3`;
        writeFileSync(path, buf);
        console.log(`✓  ${path}`);
      } catch (e) { console.log(`✗  ${e.message}`); }
    } else {
      console.log('  (No pronunciation dictionary found — run: node src/video/pronunciation-dict.js create)');
    }
  }
}

async function main() {
  if (!ELEVENLABS_KEY) { console.error('ERROR: ELEVENLABS_API_KEY must be set'); process.exit(1); }

  const suburbs = args.all
    ? (await import('./pronunciation-dict.js')).SUBURB_ALIASES.map(a => a.suburb)
    : positionals;

  if (!suburbs.length) {
    console.log('Usage:');
    console.log('  node src/video/test-pronunciation.js Wahroonga');
    console.log('  node src/video/test-pronunciation.js "Point Piper"');
    console.log('  node src/video/test-pronunciation.js --google Wahroonga');
    console.log('  node src/video/test-pronunciation.js --all');
    return;
  }

  for (const suburb of suburbs) {
    await testSuburb(suburb);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nOutput dir: ${OUT_DIR}`);
  console.log('Open files: xdg-open ' + OUT_DIR);
}

main().catch(e => { console.error(e.message); process.exit(1); });
