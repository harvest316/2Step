#!/usr/bin/env node

/**
 * Upload PLS pronunciation files to ElevenLabs.
 *
 * Creates a pronunciation dictionary from the PLS file for the specified country.
 * Stores the dict ID + version ID in data/pronunciation/.pls-dict-ids.json
 * for use by the video pipeline.
 *
 * Usage:
 *   node scripts/upload-pls.js --country AU
 *   node scripts/upload-pls.js --all
 *   node scripts/upload-pls.js --country AU --force  # re-upload even if exists
 */

import '../src/utils/load-env.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data/pronunciation');
const IDS_PATH = resolve(DATA_DIR, '.pls-dict-ids.json');

const KEY = process.env.ELEVENLABS_API_KEY;
const BASE = 'https://api.elevenlabs.io/v1';

if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

const { values: args } = parseArgs({
  options: {
    country: { type: 'string' },
    all:     { type: 'boolean', default: false },
    force:   { type: 'boolean', default: false },
  },
  strict: false,
});

const ALL = ['AU', 'UK', 'US', 'CA', 'NZ', 'IE', 'ZA'];

function loadDictIds() {
  if (!existsSync(IDS_PATH)) return {};
  try { return JSON.parse(readFileSync(IDS_PATH, 'utf8')); } catch { return {}; }
}

function saveDictIds(ids) {
  writeFileSync(IDS_PATH, JSON.stringify(ids, null, 2));
}

async function uploadPLS(cc) {
  const plsPath = resolve(DATA_DIR, `${cc.toLowerCase()}.pls`);
  if (!existsSync(plsPath)) {
    console.log(`  ${cc}: No PLS file at ${plsPath} — skipping`);
    return null;
  }

  const pls = readFileSync(plsPath, 'utf8');
  const entryCount = (pls.match(/<lexeme>/g) || []).length;

  console.log(`  ${cc}: Uploading ${plsPath} (${entryCount} entries)...`);

  const form = new FormData();
  form.append('name', `2step-${cc.toLowerCase()}-${Date.now()}`);
  form.append('file', new Blob([pls], { type: 'text/xml' }), `${cc.toLowerCase()}.pls`);

  const res = await fetch(`${BASE}/pronunciation-dictionaries/add-from-file`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`  ${cc}: Upload failed: ${res.status} ${err.slice(0, 200)}`);
    return null;
  }

  const dict = await res.json();
  console.log(`  ${cc}: ✓ Dict ${dict.id} (${dict.version_rules_num} rules)`);
  return {
    id: dict.id,
    version_id: dict.version_id,
    uploaded_at: new Date().toISOString(),
    entry_count: dict.version_rules_num,
  };
}

async function main() {
  const countries = args.all ? ALL : args.country ? [args.country.toUpperCase()] : [];

  if (!countries.length) {
    console.log('Usage:');
    console.log('  node scripts/upload-pls.js --country AU');
    console.log('  node scripts/upload-pls.js --all');
    return;
  }

  const ids = loadDictIds();

  for (const cc of countries) {
    if (ids[cc] && !args.force) {
      console.log(`  ${cc}: Already uploaded (${ids[cc].id}). Use --force to re-upload.`);
      continue;
    }

    const result = await uploadPLS(cc);
    if (result) {
      ids[cc] = result;
      saveDictIds(ids);
    }
  }

  console.log(`\nDict IDs saved to ${IDS_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
