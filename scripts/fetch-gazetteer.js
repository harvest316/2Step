#!/usr/bin/env node

/**
 * Download and cache Geonames place name data for a country.
 *
 * Geonames provides a consistent format across all countries with bulk download.
 * We filter to populated places (feature_class = 'P') for manageable PLS size.
 *
 * Usage:
 *   node scripts/fetch-gazetteer.js --country AU
 *   node scripts/fetch-gazetteer.js --country UK
 *   node scripts/fetch-gazetteer.js --all
 *   node scripts/fetch-gazetteer.js --country AU --min-pop 200  # filter by population
 *
 * Output: data/gazetteers/{cc}.json
 *
 * Geonames data format (tab-separated):
 *   geonameid, name, asciiname, alternatenames, latitude, longitude,
 *   feature_class, feature_code, country_code, cc2, admin1_code,
 *   admin2_code, admin3_code, admin4_code, population, elevation,
 *   dem, timezone, modification_date
 */

import { mkdirSync, writeFileSync, existsSync, createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import { createUnzip } from 'zlib';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data/gazetteers');
const CACHE_DIR = resolve(ROOT, 'data/gazetteers/.cache');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

const { values: args } = parseArgs({
  options: {
    country:    { type: 'string' },
    all:        { type: 'boolean', default: false },
    'min-pop':  { type: 'string', default: '0' },
    force:      { type: 'boolean', default: false },
  },
  strict: false,
});

// Geonames uses ISO 3166-1 alpha-2 — map our codes
const COUNTRY_MAP = {
  AU: 'AU',
  UK: 'GB',  // Geonames uses GB not UK
  US: 'US',
  CA: 'CA',
  NZ: 'NZ',
  IE: 'IE',
  ZA: 'ZA',
};

const ALL_COUNTRIES = Object.keys(COUNTRY_MAP);

// Admin1 code → state name (loaded on demand)
let _admin1Names = null;

async function loadAdmin1Names() {
  if (_admin1Names) return _admin1Names;
  _admin1Names = new Map();

  const admin1Path = resolve(CACHE_DIR, 'admin1CodesASCII.txt');
  if (!existsSync(admin1Path)) {
    console.log('  Downloading admin1 codes...');
    execSync(`curl -sL "http://download.geonames.org/export/dump/admin1CodesASCII.txt" -o "${admin1Path}"`, { timeout: 30000 });
  }

  const rl = createInterface({ input: createReadStream(admin1Path) });
  for await (const line of rl) {
    const [code, name] = line.split('\t');
    if (code && name) _admin1Names.set(code, name);
  }
  return _admin1Names;
}

async function downloadGeonames(geonamesCC) {
  const zipPath = resolve(CACHE_DIR, `${geonamesCC}.zip`);
  const txtPath = resolve(CACHE_DIR, `${geonamesCC}.txt`);

  if (!existsSync(txtPath) || args.force) {
    console.log(`  Downloading ${geonamesCC}.zip from geonames.org...`);
    execSync(`curl -sL "http://download.geonames.org/export/dump/${geonamesCC}.zip" -o "${zipPath}"`, { timeout: 120000 });
    execSync(`cd "${CACHE_DIR}" && unzip -o "${zipPath}" "${geonamesCC}.txt" 2>/dev/null`, { timeout: 30000 });
  } else {
    console.log(`  Using cached ${geonamesCC}.txt`);
  }

  return txtPath;
}

async function processGeonames(ourCC, geonamesCC, minPop) {
  const txtPath = await downloadGeonames(geonamesCC);
  const admin1 = await loadAdmin1Names();

  const places = [];
  const rl = createInterface({ input: createReadStream(txtPath) });

  for await (const line of rl) {
    const fields = line.split('\t');
    if (fields.length < 19) continue;

    const [
      geonameid, name, asciiname, alternatenames,
      lat, lon, featureClass, featureCode,
      countryCode, cc2, admin1Code,
      admin2Code, admin3Code, admin4Code,
      population,
    ] = fields;

    // Filter: populated places only
    if (featureClass !== 'P') continue;

    const pop = parseInt(population) || 0;
    if (pop < minPop) continue;

    // Get state/region name for disambiguation
    const admin1Key = `${countryCode}.${admin1Code}`;
    const state = admin1.get(admin1Key) || admin1Code || '';

    places.push({
      name,
      ascii: asciiname,
      state,
      population: pop,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      featureCode,
    });
  }

  // Sort by population descending (most important first)
  places.sort((a, b) => b.population - a.population);

  return places;
}

async function processCountry(ourCC) {
  const geonamesCC = COUNTRY_MAP[ourCC];
  if (!geonamesCC) {
    console.error(`Unknown country: ${ourCC}`);
    return;
  }

  const minPop = parseInt(args['min-pop']) || 0;
  const outPath = resolve(DATA_DIR, `${ourCC.toLowerCase()}.json`);

  if (existsSync(outPath) && !args.force) {
    const existing = JSON.parse(require('fs').readFileSync(outPath, 'utf8'));
    console.log(`  ${ourCC}: ${outPath} already exists (${existing.length} places). Use --force to re-download.`);
    return;
  }

  console.log(`\n=== ${ourCC} (geonames: ${geonamesCC}) ===`);
  const places = await processGeonames(ourCC, geonamesCC, minPop);

  writeFileSync(outPath, JSON.stringify(places, null, 2));
  console.log(`  → ${outPath} (${places.length} populated places, min pop ${minPop})`);

  // Stats
  const withPop = places.filter(p => p.population > 0).length;
  const top5 = places.slice(0, 5).map(p => `${p.name} (${p.population.toLocaleString()})`).join(', ');
  console.log(`  ${withPop} with known population. Top 5: ${top5}`);
}

async function main() {
  const countries = args.all ? ALL_COUNTRIES : args.country ? [args.country.toUpperCase()] : [];

  if (!countries.length) {
    console.log('Usage:');
    console.log('  node scripts/fetch-gazetteer.js --country AU');
    console.log('  node scripts/fetch-gazetteer.js --all');
    console.log('  node scripts/fetch-gazetteer.js --country AU --min-pop 200');
    console.log(`\nAvailable: ${ALL_COUNTRIES.join(', ')}`);
    return;
  }

  for (const cc of countries) {
    await processCountry(cc);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
