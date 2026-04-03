/**
 * Multi-source pronunciation gatherer with 3-source agreement.
 *
 * Independent sources (for agreement counting):
 *   1. Manual overrides (always wins, bypasses agreement)
 *   2. Wikimedia (Wikipedia + Wiktionary + Wikidata — ONE source, same editorial pool)
 *   3. CMU Pronunciation Dictionary (134K US English entries)
 *   4. OpenStreetMap (name:pronunciation tag, ~735 places, mostly UK)
 *   5. Opus web researcher (on-demand, searches council/govt/tourism sites)
 *
 * Confidence levels:
 *   'override'       — human-verified in overrides.json
 *   'verified'       — 3+ independent sources agree
 *   'likely'         — 2 sources agree
 *   'single-source'  — only 1 authoritative source
 *   'unverified'     — no agreement, needs review
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ipaToCmu, parseWikipediaIPA, cmuToIpa } from './ipa-to-cmu.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DATA_DIR = resolve(ROOT, 'data/pronunciation');
const CMU_DICT_PATH = resolve(DATA_DIR, 'cmudict.dict');
const OVERRIDES_PATH = resolve(DATA_DIR, 'overrides.json');

// ─── Source 1: Manual overrides ──────────────────────────────────────────────

let _overrides = null;

function loadOverrides() {
  if (_overrides) return _overrides;
  _overrides = new Map();

  if (!existsSync(OVERRIDES_PATH)) return _overrides;

  try {
    const data = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    for (const entry of data) {
      const key = `${entry.name.toLowerCase()}|${(entry.country || '').toUpperCase()}`;
      _overrides.set(key, entry);
    }
  } catch (e) {
    console.warn('Failed to load overrides:', e.message);
  }

  return _overrides;
}

export function lookupOverride(placeName, country) {
  const overrides = loadOverrides();
  const key = `${placeName.toLowerCase()}|${country.toUpperCase()}`;
  const entry = overrides.get(key);
  if (!entry) return null;
  return { cmu: entry.cmu, source: `override:${entry.source || 'manual'}`, note: entry.note };
}

// ─── Source 2: Wikimedia (Wikipedia + Wiktionary + Wikidata as ONE source) ───

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKT_API = 'https://en.wiktionary.org/w/api.php';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
let _lastWikiCall = 0;

async function wikiRateLimit() {
  const minInterval = 300; // 200 RPM
  const elapsed = Date.now() - _lastWikiCall;
  if (elapsed < minInterval) {
    await new Promise(r => setTimeout(r, minInterval - elapsed));
  }
  _lastWikiCall = Date.now();
}

/**
 * Combined Wikimedia lookup — queries Wikipedia, Wiktionary, and Wikidata.
 * Returns ONE result (best of three). This counts as ONE independent source.
 */
export async function lookupWikimedia(placeName, country, disambiguation) {
  // Try all three in parallel
  const [wiki, wikt, wikidata] = await Promise.all([
    lookupWikipedia(placeName, disambiguation || countryToDisambiguation(country)),
    lookupWiktionary(placeName, country),
    lookupWikidata(placeName),
  ]);

  // Prefer Wiktionary (dialect-specific), then Wikipedia (widest coverage), then Wikidata
  const best = wikt || wiki || wikidata;
  if (!best) return null;

  // Tag which Wikimedia project provided it
  return {
    ...best,
    source: best.source || 'wikimedia',
    // Store all for debugging
    _wikiSources: { wikipedia: wiki, wiktionary: wikt, wikidata },
  };
}

async function lookupWikipedia(placeName, disambiguation) {
  await wikiRateLimit();

  const titles = [placeName];
  if (disambiguation) {
    titles.push(`${placeName}, ${disambiguation}`);
    titles.push(`${placeName} (${disambiguation})`);
  }

  for (const title of titles) {
    try {
      const params = new URLSearchParams({
        action: 'query', titles: title, prop: 'revisions',
        rvprop: 'content', format: 'json', rvslots: 'main', redirects: '1',
      });
      const res = await fetch(`${WIKI_API}?${params}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pages = data.query?.pages;
      if (!pages) continue;

      for (const page of Object.values(pages)) {
        if (page.missing !== undefined) continue;
        const wikitext = page.revisions?.[0]?.slots?.main?.['*'];
        if (!wikitext) continue;
        const ipa = extractIPA(wikitext);
        if (ipa) {
          return { ipa, cmu: ipaToCmu(ipa), source: `wikimedia:wikipedia:${page.title}` };
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

async function lookupWiktionary(placeName, country) {
  await wikiRateLimit();

  try {
    const params = new URLSearchParams({
      action: 'parse', page: placeName, prop: 'wikitext', format: 'json',
    });
    const res = await fetch(`${WIKT_API}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const wikitext = data.parse?.wikitext?.['*'];
    if (!wikitext) return null;

    // Wiktionary has dialect-specific IPA: {{IPA|en|/ˈmɛlbən/|a=AusE}}
    // Try to find the dialect matching the country first
    const dialectMap = { AU: 'AusE', UK: 'RP', US: 'GenAm', NZ: 'NZE', CA: 'GenAm', IE: 'IE', ZA: 'SAE' };
    const targetDialect = dialectMap[country];

    // Extract all IPA entries with their dialect tags
    const ipaEntries = [];
    const ipaPattern = /\{\{IPA\|en\|\/([^\/]+)\/(?:\|a=([^}|]+))?\}\}/g;
    let match;
    while ((match = ipaPattern.exec(wikitext)) !== null) {
      ipaEntries.push({ ipa: match[1], dialect: match[2] || 'generic' });
    }

    // Also check {{enPR|...}} and {{a|...}} {{IPA|en|...}} patterns
    const altPattern = /\{\{a\|([^}]+)\}\}\s*\{\{IPA\|en\|\/([^\/]+)\//g;
    while ((match = altPattern.exec(wikitext)) !== null) {
      ipaEntries.push({ ipa: match[2], dialect: match[1] });
    }

    if (!ipaEntries.length) return null;

    // Pick dialect-specific if available, otherwise first
    const dialectMatch = ipaEntries.find(e => e.dialect === targetDialect);
    const best = dialectMatch || ipaEntries[0];

    return {
      ipa: best.ipa,
      cmu: ipaToCmu(best.ipa),
      source: `wikimedia:wiktionary:${placeName}:${best.dialect}`,
      dialect: best.dialect,
    };
  } catch { return null; }
}

async function lookupWikidata(placeName) {
  try {
    // First find the Wikidata entity ID for this place
    await wikiRateLimit();
    const searchParams = new URLSearchParams({
      action: 'wbsearchentities', search: placeName, language: 'en',
      type: 'item', format: 'json', limit: '3',
    });
    const searchRes = await fetch(`https://www.wikidata.org/w/api.php?${searchParams}`);
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const entities = searchData.search || [];

    for (const entity of entities) {
      // Check P898 (IPA transcription)
      const query = `SELECT ?ipa WHERE { wd:${entity.id} wdt:P898 ?ipa }`;
      const sparqlRes = await fetch(
        `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}&format=json`,
        { headers: { Accept: 'application/sparql-results+json' } }
      );
      if (!sparqlRes.ok) continue;
      const sparqlData = await sparqlRes.json();
      const bindings = sparqlData.results?.bindings;
      if (bindings?.length) {
        const ipa = bindings[0].ipa.value;
        return { ipa, cmu: ipaToCmu(ipa), source: `wikimedia:wikidata:${entity.id}` };
      }
    }
  } catch { /* skip */ }
  return null;
}

function extractIPA(wikitext) {
  const clean = wikitext.replace(/<!--[\s\S]*?-->/g, '');

  const ipacMatch = clean.match(/\{\{IPAc-en\|([^}]+)\}\}/);
  if (ipacMatch) {
    let parts = ipacMatch[1];
    parts = parts.replace(/audio=[^|]+\|?/g, '');
    parts = parts.replace(/\|?\(|\)/g, '');
    parts = parts.replace(/^\|+|\|+$/g, '');
    return parseWikipediaIPA(parts);
  }

  const ipaEnMatch = clean.match(/\{\{IPA-en\|[\/\[]([^\/\]]+)[\/\]]/);
  if (ipaEnMatch) return ipaEnMatch[1];

  const intro = clean.substring(0, 800);
  const slashMatch = intro.match(/\/([\u0250-\u02FF\u0300-\u036Fɑæɒʌəɛɜɪʊiueoaɔˈˌːbdfɡhɹɾjklmnŋprsʃtθðvwzʒ.]+)\//);
  if (slashMatch && slashMatch[1].length >= 3) return slashMatch[1];

  return null;
}

// ─── Source 3: CMU Pronunciation Dictionary ──────────────────────────────────

let _cmuIndex = null;

function loadCmuDict() {
  if (_cmuIndex) return _cmuIndex;
  _cmuIndex = new Map();

  if (!existsSync(CMU_DICT_PATH)) {
    console.warn('CMU dict not found at', CMU_DICT_PATH);
    return _cmuIndex;
  }

  const lines = readFileSync(CMU_DICT_PATH, 'utf8').split('\n');
  for (const line of lines) {
    if (line.startsWith(';;;') || !line.trim()) continue;
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const word = line.substring(0, spaceIdx).toLowerCase();
    const phonemes = line.substring(spaceIdx).trim();
    const baseWord = word.replace(/\(\d+\)$/, '');
    if (!_cmuIndex.has(baseWord)) _cmuIndex.set(baseWord, []);
    _cmuIndex.get(baseWord).push(phonemes);
  }

  return _cmuIndex;
}

export function lookupCmu(placeName) {
  const dict = loadCmuDict();
  const key = placeName.toLowerCase().replace(/[^a-z]/g, '');
  const entries = dict.get(key);
  if (!entries) return null;
  return { cmu: entries[0], source: 'cmu' };
}

// ─── Source 4: OpenStreetMap (Overpass API) ──────────────────────────────────

const OVERPASS_API = 'https://overpass-api.de/api/interpreter';

const OSM_COUNTRY_CODES = {
  AU: '3600080500', // Australia relation ID
  UK: '3600062149', // United Kingdom
  US: '3600148838', // USA
  CA: '3600001428', // Canada
  NZ: '3600556706', // New Zealand
  IE: '3600062273', // Ireland
  ZA: '3600087565', // South Africa
};

export async function lookupOSM(placeName, country) {
  const areaId = OSM_COUNTRY_CODES[country];
  if (!areaId) return null;

  try {
    const query = `[out:json][timeout:10];
area(${areaId})->.country;
(node["name"="${placeName}"]["name:pronunciation"](area.country);
 way["name"="${placeName}"]["name:pronunciation"](area.country););
out tags 1;`;

    const res = await fetch(OVERPASS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return null;

    const data = await res.json();
    const elements = data.elements || [];
    if (!elements.length) return null;

    const pronunciation = elements[0].tags?.['name:pronunciation'];
    if (!pronunciation) return null;

    const cmu = ipaToCmu(pronunciation);
    return { ipa: pronunciation, cmu, source: `osm:${elements[0].id}` };
  } catch { return null; }
}

// ─── Source 5: Opus web researcher ──────────────────────────────────────────

// Country names for search queries
const COUNTRY_NAMES = {
  AU: 'Australia', UK: 'United Kingdom', US: 'United States',
  CA: 'Canada', NZ: 'New Zealand', IE: 'Ireland', ZA: 'South Africa',
};

/**
 * Research pronunciation via Opus web search agent.
 * Called when automated sources give < 3 agreeing results.
 *
 * @param {string} name - Place name
 * @param {string} country - Country code
 * @param {string} state - State/region for disambiguation
 * @param {Array<{cmu: string, source: string}>} existingSources - Already gathered
 * @param {Function} spawnAgent - Agent spawner function (injected to avoid circular dep)
 * @returns {Promise<Array<{cmu: string, ipa?: string, source: string, note?: string}>>}
 */
export async function researchPronunciation(name, country, state, existingSources, spawnAgent) {
  if (!spawnAgent) return [];

  const countryName = COUNTRY_NAMES[country] || country;
  const existingIPA = existingSources
    .filter(s => s?.cmu)
    .map(s => `${s.source}: ${cmuToIpa(s.cmu) || s.cmu}`)
    .join('\n  ');

  const prompt = `Research the correct local pronunciation of the place name "${name}" in ${state || ''}, ${countryName}.

I already have these pronunciations from automated sources:
  ${existingIPA || '(none found)'}

Search for the pronunciation using country-restricted searches (${countryName} only):
- "${name} pronunciation"
- "${name} pronunciation ${state || ''}"
- "${name}" on local council, government, or tourism websites

For each source you find, return:
- The IPA pronunciation (e.g. /wʊˈlɑːrə/)
- The source URL
- Whether this is an authoritative source (government, council, university) or informal (forum, blog)

IMPORTANT: Return your findings as a JSON array:
[{"ipa": "/wʊˈlɑːrə/", "source": "https://example.com/...", "authoritative": true, "note": "City council pronunciation guide"}]

If you cannot find any pronunciation data, return: []`;

  try {
    const response = await spawnAgent(prompt);
    // Parse JSON from agent response
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const findings = JSON.parse(jsonMatch[0]);
    return findings
      .filter(f => f.ipa)
      .map(f => {
        const ipa = f.ipa.replace(/^\/|\/$/g, ''); // strip slashes
        return {
          cmu: ipaToCmu(ipa),
          ipa,
          source: `research:${f.source || 'web'}`,
          note: f.note,
          authoritative: f.authoritative,
        };
      })
      .filter(f => f.cmu); // only keep if conversion succeeded
  } catch { return []; }
}

// ─── Agreement counting ─────────────────────────────────────────────────────

function normaliseCmu(cmu) {
  return cmu.replace(/[012]/g, '').trim().toLowerCase();
}

/**
 * Group sources by normalised CMU pronunciation.
 * Returns array of groups sorted by size (largest first).
 */
function groupByAgreement(sources) {
  const groups = new Map();
  for (const src of sources) {
    if (!src?.cmu) continue;
    const norm = normaliseCmu(src.cmu);
    if (!groups.has(norm)) groups.set(norm, { cmu: src.cmu, norm, sources: [] });
    groups.get(norm).sources.push(src);
  }
  return [...groups.values()].sort((a, b) => b.sources.length - a.sources.length);
}

// ─── Cross-reference with agreement ─────────────────────────────────────────

function countryToDisambiguation(country) {
  const map = {
    AU: 'New South Wales', UK: 'England', US: null, CA: 'Canada',
    NZ: 'New Zealand', IE: 'Ireland', ZA: 'South Africa',
  };
  return map[country] || null;
}

/**
 * @typedef {Object} PronunciationResult
 * @property {string} name
 * @property {string} country
 * @property {string} cmu - Best pronunciation
 * @property {string} source - Winning source(s)
 * @property {string} confidence - 'override'|'verified'|'likely'|'single-source'|'unverified'
 * @property {number} agreementCount - How many independent sources agree
 * @property {Object} sources - All source results
 * @property {string[]} conflicts
 */

/**
 * Gather pronunciation from all sources with 3-source agreement target.
 *
 * @param {string} name
 * @param {string} country
 * @param {string} [disambiguation]
 * @param {Object} [options]
 * @param {Function} [options.spawnAgent] - Agent spawner for Opus researcher
 * @param {boolean} [options.skipResearch=false] - Skip Opus researcher (for quick lookups)
 * @returns {Promise<PronunciationResult>}
 */
export async function gatherPronunciation(name, country, disambiguation, options = {}) {
  const { spawnAgent, skipResearch = false } = options;

  const result = {
    name, country,
    cmu: null, source: null, confidence: 'unverified',
    agreementCount: 0, sources: {}, conflicts: [],
  };

  // 1. Override always wins
  const override = lookupOverride(name, country);
  if (override) {
    result.sources.override = override;
    result.cmu = override.cmu;
    result.source = override.source;
    result.confidence = 'override';
    return result;
  }

  // 2. Gather all automated independent sources
  const [wikimedia, osm] = await Promise.all([
    lookupWikimedia(name, country, disambiguation),
    lookupOSM(name, country),
  ]);
  const cmuEntry = lookupCmu(name);

  if (wikimedia) result.sources.wikimedia = wikimedia;
  if (cmuEntry) result.sources.cmu = cmuEntry;
  if (osm) result.sources.osm = osm;

  // 3. Count agreement
  const independentSources = [wikimedia, cmuEntry, osm].filter(Boolean);
  let groups = groupByAgreement(independentSources);

  // 4. If < 3 agreement, trigger Opus researcher
  if (groups[0]?.sources.length < 3 && !skipResearch && spawnAgent) {
    const researched = await researchPronunciation(
      name, country, disambiguation, independentSources, spawnAgent
    );
    if (researched.length) {
      result.sources.research = researched;
      const allSources = [...independentSources, ...researched];
      groups = groupByAgreement(allSources);
    }
  }

  // 5. Pick winner
  if (!groups.length) return result;

  const best = groups[0];
  result.cmu = best.cmu;
  result.agreementCount = best.sources.length;
  result.source = best.sources.map(s => s.source).join(' + ');

  if (best.sources.length >= 3) {
    result.confidence = 'verified';
  } else if (best.sources.length >= 2) {
    result.confidence = 'likely';
  } else {
    result.confidence = 'single-source';
  }

  // Log conflicts between groups
  if (groups.length > 1) {
    for (const g of groups.slice(1)) {
      result.conflicts.push(
        `Disagreement: ${g.sources.map(s => s.source).join('+')} say ${g.cmu} (${cmuToIpa(g.cmu) || '?'}) ` +
        `vs winner ${best.cmu} (${cmuToIpa(best.cmu) || '?'})`
      );
    }
  }

  return result;
}

// ─── Batch lookup (Wikipedia only, for gazetteer pre-population) ────────────

export async function batchLookupWikipedia(places) {
  const results = new Map();
  const BATCH_SIZE = 50;

  for (let i = 0; i < places.length; i += BATCH_SIZE) {
    const batch = places.slice(i, i + BATCH_SIZE);
    await wikiRateLimit();

    const titleMap = new Map();
    for (const p of batch) {
      const titles = [p.name];
      if (p.disambiguation) titles.unshift(`${p.name}, ${p.disambiguation}`);
      for (const t of titles) titleMap.set(t, p);
    }

    const params = new URLSearchParams({
      action: 'query', titles: [...titleMap.keys()].join('|'),
      prop: 'revisions', rvprop: 'content', format: 'json', rvslots: 'main', redirects: '1',
    });

    try {
      const res = await fetch(`${WIKI_API}?${params}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pages = data.query?.pages;
      if (!pages) continue;

      for (const page of Object.values(pages)) {
        if (page.missing !== undefined) continue;
        const wikitext = page.revisions?.[0]?.slots?.main?.['*'];
        if (!wikitext) continue;
        const place = titleMap.get(page.title);
        const name = place?.name || page.title.split(',')[0].split('(')[0].trim();
        if (results.has(name)) continue;
        const ipa = extractIPA(wikitext);
        if (ipa) {
          results.set(name, { ipa, cmu: ipaToCmu(ipa), source: `wikimedia:wikipedia:${page.title}` });
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

// ─── PLS generation ──────────────────────────────────────────────────────────

export function generatePLS(results) {
  const lexemes = results
    .filter(r => r.cmu)
    .map(r =>
      `  <lexeme>\n` +
      `    <grapheme>${escapeXml(r.name)}</grapheme>\n` +
      `    <phoneme>${escapeXml(r.cmu)}</phoneme>\n` +
      `  </lexeme>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" alphabet="cmu-arpabet" xml:lang="en">
${lexemes}
</lexicon>`;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
