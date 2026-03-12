#!/usr/bin/env node

/**
 * ElevenLabs Pronunciation Dictionary manager for Australian suburb names.
 *
 * Replaces the in-text SUBURB_PHONETICS respelling approach with a server-side
 * alias dictionary attached to every TTS call. Alias rules = pure text substitution
 * before synthesis — works with eleven_turbo_v2_5 (unlike SSML phoneme tags which
 * are silently ignored by turbo models).
 *
 * The dictionary is created once and stored on ElevenLabs servers. The ID is saved
 * to .pronunciation-dict.json and reused on every TTS call.
 *
 * Alias format: lowercase, spaces between syllables — no hyphens, no ALL CAPS.
 * e.g. "Wahroonga" → "wah roonga"  (not "Wah-ROON-ga" which risks P-I-E spelling)
 *
 * Usage:
 *   node src/video/pronunciation-dict.js create    # Create/recreate the dictionary
 *   node src/video/pronunciation-dict.js list      # Show current rules + EL dict ID
 *   node src/video/pronunciation-dict.js test      # Generate test audio for each suburb
 *
 * After running create, restart shotstack.js — it auto-loads the dict ID.
 */

import '../utils/load-env.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DICT_CACHE_PATH = resolve(ROOT, '.pronunciation-dict.json');

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'IKne3meq5aSn9XLyUdCD';
const EL_BASE = 'https://api.elevenlabs.io/v1';

if (!ELEVENLABS_KEY) { console.error('ERROR: ELEVENLABS_API_KEY must be set'); process.exit(1); }

// ─── Suburb alias rules ────────────────────────────────────────────────────────
//
// Format: { suburb: string, alias: string }
// alias = lowercase phonetic respelling, spaces between syllables.
// DO NOT use ALL CAPS or hyphens — ElevenLabs may spell out short caps tokens.
//
// How to derive aliases:
//   1. Run: node src/video/test-pronunciation.js <SuburbName>
//      This generates Google TTS en-AU audio to /tmp/<SuburbName>.mp3
//   2. Listen and write what you hear as lowercase syllables with spaces
//   3. Add the entry here, then run: node src/video/pronunciation-dict.js create
//
// Verified against Google TTS en-AU-Neural2-D unless noted.
//
export const SUBURB_ALIASES = [
  // ── North Shore / Upper North Shore ───────────────────────────────────────
  { suburb: 'Wahroonga',     alias: 'wah roonga' },
  { suburb: 'Artarmon',      alias: 'ar tar mon' },
  { suburb: 'Turramurra',    alias: 'turra murra' },
  { suburb: 'Pymble',        alias: 'pim bul' },
  { suburb: 'Killara',       alias: 'ki lara' },
  { suburb: 'Pennant Hills', alias: 'pennant hills' },      // standard, may not need alias
  { suburb: 'Beecroft',      alias: 'bee croft' },
  { suburb: 'Cherrybrook',   alias: 'cherry brook' },
  { suburb: 'Epping',        alias: 'epping' },             // standard
  { suburb: 'Chatswood',     alias: 'chats wood' },
  { suburb: 'Naremburn',     alias: 'nare burn' },
  { suburb: 'Willoughby',    alias: 'willo bee' },
  { suburb: 'Castlecrag',    alias: 'castle krag' },

  // ── Northern Beaches ──────────────────────────────────────────────────────
  { suburb: 'Balgowlah',     alias: 'bal gowla' },
  { suburb: 'Manly Vale',    alias: 'manly vale' },
  { suburb: 'Narrabeen',     alias: 'narra been' },
  { suburb: 'Mona Vale',     alias: 'mona vale' },
  { suburb: 'Avalon Beach',  alias: 'avalon beach' },
  { suburb: 'Terrey Hills',  alias: 'terry hills' },
  { suburb: 'Seaforth',      alias: 'sea forth' },

  // ── Inner West / Hills ────────────────────────────────────────────────────
  { suburb: 'Parramatta',    alias: 'para matta' },
  { suburb: 'Dural',         alias: 'dyoo ral' },
  { suburb: 'Galston',       alias: 'gawl ston' },
  { suburb: 'Glenhaven',     alias: 'glen hay ven' },
  { suburb: 'Kenthurst',     alias: 'kent hurst' },
  { suburb: 'Annangrove',    alias: 'anna grove' },
  { suburb: 'Glenorie',      alias: 'glen or ee' },
  { suburb: 'Cammeray',      alias: 'kam er ay' },

  // ── Eastern Suburbs ───────────────────────────────────────────────────────
  { suburb: 'Woollahra',     alias: 'wool ara' },
  { suburb: 'Woolloomooloo', alias: 'wool oo moo loo' },
  { suburb: 'Point Piper',   alias: 'point piper' },        // verify — may be fine
  { suburb: 'Kirribilli',    alias: 'kirri billy' },
  { suburb: 'Cremorne',      alias: 'cre morn' },
  { suburb: 'Mosman',        alias: 'mozman' },
  { suburb: 'Neutral Bay',   alias: 'noo tral bay' },

  // ── Other ─────────────────────────────────────────────────────────────────
  { suburb: 'Ryde',          alias: 'ryde' },               // standard
  { suburb: 'Manly',         alias: 'manly' },              // standard
];

// ─── API helpers ───────────────────────────────────────────────────────────────

async function elFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${EL_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs ${method} ${path} → ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function create() {
  const rules = SUBURB_ALIASES.map(({ suburb, alias }) => ({
    type: 'alias',
    string_to_replace: suburb,
    alias,
    case_sensitive: false,
    word_boundaries: true,
  }));

  console.log(`Creating ElevenLabs pronunciation dictionary with ${rules.length} alias rules...`);

  // Check if we already have a dictionary — if so, add rules to it (EL has no delete endpoint)
  let dictId = null;
  if (existsSync(DICT_CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(DICT_CACHE_PATH, 'utf8'));
    dictId = cached.id || null;
    if (dictId) console.log(`  Updating existing dictionary: ${dictId}`);
  }

  let result;
  if (dictId) {
    // Add/replace rules in existing dictionary
    result = await elFetch(`/pronunciation-dictionaries/${dictId}/add-rules`, 'POST', { rules });
    result.id = dictId;
  } else {
    // Create new dictionary
    result = await elFetch('/pronunciation-dictionaries/add-from-rules', 'POST', {
      name: 'au-suburbs-2step',
      rules,
    });
  }

  const cache = { id: result.id, version_id: result.version_id, created_at: new Date().toISOString(), rule_count: rules.length };
  writeFileSync(DICT_CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`  ✓ Created: ${result.id} (version ${result.version_id})`);
  console.log(`  Saved to ${DICT_CACHE_PATH}`);
  console.log('\nRestart shotstack.js — it will auto-load the new dictionary.');
}

async function list() {
  if (!existsSync(DICT_CACHE_PATH)) {
    console.log('No dictionary created yet. Run: node src/video/pronunciation-dict.js create');
    return;
  }
  const cached = JSON.parse(readFileSync(DICT_CACHE_PATH, 'utf8'));
  console.log(`Dictionary ID : ${cached.id}`);
  console.log(`Version       : ${cached.version_id}`);
  console.log(`Created       : ${cached.created_at}`);
  console.log(`Rules         : ${cached.rule_count}`);
  console.log('\nAlias rules in SUBURB_ALIASES:');
  for (const { suburb, alias } of SUBURB_ALIASES) {
    console.log(`  "${suburb}" → "${alias}"`);
  }
}

async function testAudio() {
  console.log('Generating ElevenLabs test audio for each suburb alias...');
  console.log('(This tests the alias substitution is working — listen for correct pronunciation)\n');
  const { mkdirSync, createWriteStream } = await import('fs');
  const outDir = '/tmp/suburb-pronunciation-test';
  mkdirSync(outDir, { recursive: true });

  // Load dict if available
  const locators = [];
  if (existsSync(DICT_CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(DICT_CACHE_PATH, 'utf8'));
    locators.push({ pronunciation_dictionary_id: cached.id, version_id: cached.version_id });
    console.log(`Using dictionary: ${cached.id}\n`);
  } else {
    console.warn('No dictionary found — testing without alias substitution\n');
  }

  for (const { suburb } of SUBURB_ALIASES) {
    const script = `This is ${suburb}.`;
    process.stdout.write(`  ${suburb}...`);
    try {
      const res = await fetch(`${EL_BASE}/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: script,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.4, similarity_boost: 0.8 },
          ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}),
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const outPath = `${outDir}/${suburb.replace(/ /g, '_')}.mp3`;
      writeFileSync(outPath, buf);
      console.log(` ✓ ${outPath}`);
    } catch (e) {
      console.log(` ✗ ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  console.log(`\nAll files in: ${outDir}`);
  console.log('Open in file manager or run: xdg-open ' + outDir);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === 'create') create().catch(e => { console.error(e.message); process.exit(1); });
else if (cmd === 'list') list().catch(e => { console.error(e.message); process.exit(1); });
else if (cmd === 'test') testAudio().catch(e => { console.error(e.message); process.exit(1); });
else {
  console.log('Usage:');
  console.log('  node src/video/pronunciation-dict.js create   # Create/recreate dictionary');
  console.log('  node src/video/pronunciation-dict.js list     # Show rules + dict ID');
  console.log('  node src/video/pronunciation-dict.js test     # Generate test audio files');
}
