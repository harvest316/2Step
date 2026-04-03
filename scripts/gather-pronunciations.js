#!/usr/bin/env node

/**
 * Pronunciation data pipeline.
 *
 * Gathers correct pronunciations from multiple authoritative sources,
 * cross-references them, flags conflicts, and generates PLS files per country.
 *
 * Sources (in priority order):
 *   1. Manual overrides (data/pronunciation/overrides.json)
 *   2. Wikipedia MediaWiki API (IPA → CMU conversion)
 *   3. CMU Pronunciation Dictionary (American English, local file)
 *
 * Usage:
 *   # Gather for specific places
 *   node scripts/gather-pronunciations.js --places "Woollahra:AU,Cairns:AU,Edinburgh:UK"
 *
 *   # Gather for all suburbs in the 2Step database
 *   node scripts/gather-pronunciations.js --from-db
 *
 *   # Gather for the 25-place test set
 *   node scripts/gather-pronunciations.js --test-set
 *
 *   # Show conflicts only
 *   node scripts/gather-pronunciations.js --test-set --conflicts-only
 *
 * Output:
 *   data/pronunciation/au.pls
 *   data/pronunciation/uk.pls
 *   data/pronunciation/us.pls
 *   etc.
 */

import '../src/utils/load-env.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { gatherPronunciation, generatePLS } from '../src/video/pronunciation-sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data/pronunciation');

mkdirSync(DATA_DIR, { recursive: true });

const { values: args } = parseArgs({
  options: {
    places:           { type: 'string' },
    'from-db':        { type: 'boolean', default: false },
    'from-gazetteer': { type: 'string' },  // country code, e.g. "AU"
    'min-pop':        { type: 'string', default: '0' },
    'test-set':       { type: 'boolean', default: false },
    'conflicts-only': { type: 'boolean', default: false },
  },
  strict: false,
});

// ─── Test set ────────────────────────────────────────────────────────────────

const TEST_SET = [
  // AU — Aboriginal and colonial names commonly mispronounced
  { name: 'Woollahra',     country: 'AU', disambiguation: 'New South Wales' },
  { name: 'Cairns',        country: 'AU', disambiguation: 'Queensland' },
  { name: 'Prahran',       country: 'AU', disambiguation: 'Victoria' },
  { name: 'Melbourne',     country: 'AU' },
  { name: 'Launceston',    country: 'AU', disambiguation: 'Tasmania' },
  { name: 'Geelong',       country: 'AU' },
  { name: 'Parramatta',    country: 'AU', disambiguation: 'New South Wales' },
  { name: 'Kirribilli',    country: 'AU', disambiguation: 'New South Wales' },
  { name: 'Woolloomooloo', country: 'AU' },

  // NZ — Māori place names
  { name: 'Taupō',         country: 'NZ' },
  { name: 'Whakapapa',     country: 'NZ', disambiguation: 'New Zealand' },
  { name: 'Tauranga',      country: 'NZ' },

  // UK — silent letters, historical pronunciation
  { name: 'Worcestershire', country: 'UK' },
  { name: 'Edinburgh',      country: 'UK' },
  { name: 'Leicester',      country: 'UK' },
  { name: 'Gloucester',     country: 'UK' },
  { name: 'Marylebone',     country: 'UK' },
  { name: 'Alnwick',        country: 'UK' },
  { name: 'Bicester',       country: 'UK' },
  { name: 'Plymouth',       country: 'UK' },

  // US/CA
  { name: 'Worcester',     country: 'US', disambiguation: 'Massachusetts' },
  { name: 'Montreal',      country: 'CA' },
  { name: 'Saskatchewan',  country: 'CA' },
  { name: 'Arkansas',      country: 'US' },
  { name: 'Nevada',        country: 'US' },
  { name: 'Wichita',       country: 'US', disambiguation: 'Kansas' },
  { name: 'Oregon',        country: 'US' },
  { name: 'Bozeman',       country: 'US', disambiguation: 'Montana' },
];

// ─── Parse input ─────────────────────────────────────────────────────────────

function parsePlaces(placesStr) {
  return placesStr.split(',').map(entry => {
    const [name, country] = entry.trim().split(':');
    return { name: name.trim(), country: (country || 'AU').trim().toUpperCase() };
  });
}

async function getPlacesFromDb() {
  const dbPath = resolve(ROOT, 'db/2step.db');
  if (!existsSync(dbPath)) {
    console.error('Database not found:', dbPath);
    process.exit(1);
  }
  // Use sqlite3 CLI to extract unique suburbs
  const { execSync } = await import('child_process');
  const rows = execSync(
    `sqlite3 "${dbPath}" "SELECT DISTINCT city, country_code FROM sites WHERE city IS NOT NULL ORDER BY country_code, city"`,
    { encoding: 'utf8' }
  ).trim().split('\n').filter(Boolean);

  return rows.map(row => {
    const [name, country] = row.split('|');
    return { name, country: country || 'AU' };
  });
}

// ─── Gazetteer loader ────────────────────────────────────────────────────────

function loadGazetteer(country) {
  const cc = country.toUpperCase();
  const path = resolve(ROOT, `data/gazetteers/${cc.toLowerCase()}.json`);
  if (!existsSync(path)) {
    console.error(`Gazetteer not found: ${path}`);
    console.error(`Run: node scripts/fetch-gazetteer.js --country ${cc}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const minPop = parseInt(args['min-pop']) || 0;
  const filtered = minPop > 0 ? data.filter(p => p.population >= minPop) : data;

  // Deduplicate by name (keep highest population entry)
  const seen = new Map();
  for (const p of filtered) {
    const key = p.name.toLowerCase();
    if (!seen.has(key) || p.population > seen.get(key).population) {
      seen.set(key, p);
    }
  }

  return [...seen.values()].map(p => ({
    name: p.name,
    country: cc,
    disambiguation: p.state || undefined,
  }));
}

// ─── Checkpoint/resume ───────────────────────────────────────────────────────

function loadCheckpoint(country) {
  const path = resolve(DATA_DIR, `results/${country.toLowerCase()}.json`);
  if (!existsSync(path)) return new Map();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Map(data.map(r => [r.name, r]));
  } catch { return new Map(); }
}

function saveCheckpoint(country, results) {
  mkdirSync(resolve(DATA_DIR, 'results'), { recursive: true });
  const path = resolve(DATA_DIR, `results/${country.toLowerCase()}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let places;

  if (args['test-set']) {
    places = TEST_SET;
  } else if (args.places) {
    places = parsePlaces(args.places);
  } else if (args['from-db']) {
    places = await getPlacesFromDb();
  } else if (args['from-gazetteer']) {
    places = loadGazetteer(args['from-gazetteer']);
  } else {
    console.log('Usage:');
    console.log('  node scripts/gather-pronunciations.js --test-set');
    console.log('  node scripts/gather-pronunciations.js --places "Woollahra:AU,Edinburgh:UK"');
    console.log('  node scripts/gather-pronunciations.js --from-db');
    console.log('  node scripts/gather-pronunciations.js --from-gazetteer AU');
    console.log('  node scripts/gather-pronunciations.js --from-gazetteer AU --min-pop 200');
    return;
  }

  console.log(`Gathering pronunciations for ${places.length} place(s)...\n`);

  // Load checkpoint for resume support (gazetteer mode only)
  const country = args['from-gazetteer']?.toUpperCase();
  const checkpoint = country ? loadCheckpoint(country) : new Map();
  if (checkpoint.size > 0) {
    console.log(`Resuming: ${checkpoint.size} already gathered, ${places.length - checkpoint.size} remaining\n`);
  }

  const results = [...checkpoint.values()]; // start with already-gathered
  let newCount = 0;

  for (const place of places) {
    // Skip if already in checkpoint
    if (checkpoint.has(place.name)) continue;

    process.stdout.write(`  ${place.country} ${place.name}... `);
    const result = await gatherPronunciation(place.name, place.country, place.disambiguation, {
      skipResearch: false, // triggers Opus researcher via OpenRouter for < 3 agreement
    });
    results.push(result);
    newCount++;

    if (args['conflicts-only'] && result.conflicts.length === 0) {
      process.stdout.write('ok\n');
    } else {
      const srcCount = result.agreementCount || 0;
      const sources = Object.keys(result.sources).join('+') || 'none';
      if (result.cmu) {
        console.log(`${result.cmu}  [${result.confidence}, ${srcCount} agree, ${sources}]`);
      } else {
        console.log(`NOT FOUND  [${sources}]`);
      }
      for (const conflict of result.conflicts) {
        console.log(`    ⚠ ${conflict}`);
      }
    }

    // Checkpoint every 50 entries (gazetteer mode)
    if (country && newCount % 50 === 0) {
      saveCheckpoint(country, results);
      process.stdout.write(`  [checkpoint: ${results.length} saved]\n`);
    }
  }

  // Final save of results (gazetteer mode)
  if (country) {
    saveCheckpoint(country, results);
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  const found = results.filter(r => r.cmu);
  const notFound = results.filter(r => !r.cmu);
  const conflicted = results.filter(r => r.conflicts.length > 0);

  // Confidence breakdown
  const byConfidence = {};
  results.forEach(r => { byConfidence[r.confidence] = (byConfidence[r.confidence] || 0) + 1; });

  console.log(`\n─── Summary ───`);
  console.log(`  Found: ${found.length}/${results.length}`);
  console.log(`  Not found: ${notFound.length}`);
  console.log(`  Conflicts: ${conflicted.length}`);
  console.log(`  Confidence: ${Object.entries(byConfidence).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (notFound.length) {
    console.log(`  Missing: ${notFound.map(r => r.name).join(', ')}`);
  }

  // ── Generate PLS per country ─────────────────────────────────────────────

  const byCountry = new Map();
  for (const r of found) {
    if (!byCountry.has(r.country)) byCountry.set(r.country, []);
    byCountry.get(r.country).push(r);
  }

  console.log(`\n─── PLS files ───`);
  for (const [country, countryResults] of byCountry) {
    const pls = generatePLS(countryResults);
    const path = resolve(DATA_DIR, `${country.toLowerCase()}.pls`);
    writeFileSync(path, pls);
    console.log(`  ${path} (${countryResults.length} entries)`);
  }

  // ── Write detailed results JSON for debugging ────────────────────────────

  const detailPath = resolve(DATA_DIR, 'last-gather-results.json');
  writeFileSync(detailPath, JSON.stringify(results, null, 2));
  console.log(`  ${detailPath} (full details)`);
}

main().catch(e => { console.error(e); process.exit(1); });
