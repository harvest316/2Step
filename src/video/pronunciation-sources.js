/**
 * Multi-source pronunciation gatherer.
 *
 * Queries multiple authoritative sources for place name pronunciations,
 * cross-references them, and flags conflicts.
 *
 * Sources:
 *   1. CMU Pronunciation Dictionary (local file, American English)
 *   2. Wikipedia MediaWiki API (IPA from article text)
 *   3. Manual overrides (data/pronunciation/overrides.json)
 *   4. Future: eSpeak-NG, BBC Pronunciation, ABC Pron Guide, Te Taura Whiri
 *
 * Output: CMU ARPAbet for each place name, with source attribution and
 * confidence level (single-source vs multi-source agreement).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ipaToCmu, parseWikipediaIPA } from './ipa-to-cmu.js';
import { espeakToCmu } from './espeak-to-cmu.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DATA_DIR = resolve(ROOT, 'data/pronunciation');
const CMU_DICT_PATH = resolve(DATA_DIR, 'cmudict.dict');
const OVERRIDES_PATH = resolve(DATA_DIR, 'overrides.json');

// ─── Source 1: CMU Pronunciation Dictionary ──────────────────────────────────

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
    // CMU dict has variants like WORD(2) — store all, primary first
    const baseWord = word.replace(/\(\d+\)$/, '');
    if (!_cmuIndex.has(baseWord)) _cmuIndex.set(baseWord, []);
    _cmuIndex.get(baseWord).push(phonemes);
  }

  return _cmuIndex;
}

/**
 * Look up a place name in the CMU dictionary.
 * @returns {{ cmu: string, variant: number }[] | null }
 */
export function lookupCmu(placeName) {
  const dict = loadCmuDict();
  const key = placeName.toLowerCase().replace(/[^a-z]/g, '');
  const entries = dict.get(key);
  if (!entries) return null;
  return entries.map((cmu, i) => ({ cmu, variant: i + 1 }));
}

// ─── Source 2: Wikipedia MediaWiki API ───────────────────────────────────────

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_RPM = 200; // rate limit
let _lastWikiCall = 0;

async function wikiRateLimit() {
  const minInterval = 60000 / WIKI_RPM; // 300ms at 200rpm
  const elapsed = Date.now() - _lastWikiCall;
  if (elapsed < minInterval) {
    await new Promise(r => setTimeout(r, minInterval - elapsed));
  }
  _lastWikiCall = Date.now();
}

/**
 * Extract IPA pronunciation from a Wikipedia article.
 * Handles both {{IPAc-en|...}} templates and /IPA/ in plain text.
 *
 * @param {string} placeName - e.g. "Woollahra"
 * @param {string} [disambiguation] - e.g. "New South Wales" to disambiguate
 * @returns {Promise<{ ipa: string, cmu: string, source: string } | null>}
 */
export async function lookupWikipedia(placeName, disambiguation) {
  await wikiRateLimit();

  // Try exact title first, then with disambiguation
  const titles = [placeName];
  if (disambiguation) {
    titles.push(`${placeName}, ${disambiguation}`);
    titles.push(`${placeName} (${disambiguation})`);
  }

  for (const title of titles) {
    try {
      const params = new URLSearchParams({
        action: 'query',
        titles: title,
        prop: 'revisions',
        rvprop: 'content',
        format: 'json',
        rvslots: 'main',
        redirects: '1',
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

        const ipa = extractIPA(wikitext, placeName);
        if (ipa) {
          const cmu = ipaToCmu(ipa);
          return { ipa, cmu, source: `wikipedia:${page.title}`, title: page.title };
        }
      }
    } catch (e) {
      // Network error — skip this title variant
    }
  }

  return null;
}

/**
 * Batch lookup multiple place names via Wikipedia API (up to 50 per request).
 * @param {Array<{name: string, disambiguation?: string}>} places
 * @returns {Promise<Map<string, { ipa: string, cmu: string, source: string }>>}
 */
export async function batchLookupWikipedia(places) {
  const results = new Map();

  // Wikipedia API allows up to 50 titles per request
  const BATCH_SIZE = 50;
  for (let i = 0; i < places.length; i += BATCH_SIZE) {
    const batch = places.slice(i, i + BATCH_SIZE);
    await wikiRateLimit();

    // Build title list — try with disambiguation suffix first
    const titleMap = new Map(); // title → place
    for (const p of batch) {
      const titles = [p.name];
      if (p.disambiguation) {
        titles.unshift(`${p.name}, ${p.disambiguation}`);
      }
      for (const t of titles) {
        titleMap.set(t, p);
      }
    }

    const params = new URLSearchParams({
      action: 'query',
      titles: [...titleMap.keys()].join('|'),
      prop: 'revisions',
      rvprop: 'content',
      format: 'json',
      rvslots: 'main',
      redirects: '1',
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

        // Match this page back to a place name
        const place = titleMap.get(page.title);
        const name = place?.name || page.title.split(',')[0].split('(')[0].trim();

        if (results.has(name)) continue; // already found

        const ipa = extractIPA(wikitext, name);
        if (ipa) {
          results.set(name, {
            ipa,
            cmu: ipaToCmu(ipa),
            source: `wikipedia:${page.title}`,
          });
        }
      }
    } catch (e) {
      // Network error — skip this batch
    }
  }

  return results;
}

/**
 * Extract IPA from wikitext.
 * Handles: {{IPAc-en|...}}, {{IPA-en|...}}, /IPA text/
 *
 * Wikipedia quirks handled:
 *   - audio=filename.ogg params inside templates
 *   - HTML comments inside templates (e.g. Melbourne's MOS:DIAPHONEMIC note)
 *   - ᵻ (U+1D7B) "free vowel" — maps to ə in our converter
 *   - Optional phonemes in parentheses: |(|l|ə|)|
 *   - Multiple variants — takes the first (primary pronunciation)
 */
function extractIPA(wikitext, placeName) {
  // Strip HTML comments from wikitext
  const clean = wikitext.replace(/<!--[\s\S]*?-->/g, '');

  // 1. {{IPAc-en|...}} — pipe-separated components
  const ipacMatch = clean.match(/\{\{IPAc-en\|([^}]+)\}\}/);
  if (ipacMatch) {
    let parts = ipacMatch[1];
    // Strip audio=... parameter
    parts = parts.replace(/audio=[^|]+\|?/g, '');
    // Strip parenthetical optional markers
    parts = parts.replace(/\|?\(|\)/g, '');
    // Strip leading/trailing pipes
    parts = parts.replace(/^\|+|\|+$/g, '');
    return parseWikipediaIPA(parts);
  }

  // 2. {{IPA-en|/..../}} or {{IPA-en|[....]}}
  const ipaEnMatch = clean.match(/\{\{IPA-en\|[\/\[]([^\/\]]+)[\/\]]/);
  if (ipaEnMatch) {
    return ipaEnMatch[1];
  }

  // 3. Plain IPA in slashes in the first paragraph
  //    Match /.../ containing at least one IPA-specific character
  const intro = clean.substring(0, 800);
  const slashMatch = intro.match(/\/([\u0250-\u02FF\u0300-\u036Fɑæɒʌəɛɜɪʊiueoaɔˈˌːbdfɡhɹɾjklmnŋprsʃtθðvwzʒ.]+)\//);
  if (slashMatch && slashMatch[1].length >= 3) {
    return slashMatch[1];
  }

  return null;
}

// ─── Source 3: Manual overrides ──────────────────────────────────────────────

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

/**
 * Look up a manual override.
 * @returns {{ cmu: string, source: string, note?: string } | null}
 */
export function lookupOverride(placeName, country) {
  const overrides = loadOverrides();
  const key = `${placeName.toLowerCase()}|${country.toUpperCase()}`;
  const entry = overrides.get(key);
  if (!entry) return null;
  return { cmu: entry.cmu, source: `override:${entry.source || 'manual'}`, note: entry.note };
}

// ─── Source 4: eSpeak-NG (WASM, fallback) ────────────────────────────────────

let _espeakWorker = null;
let _espeakModule = null;

async function getEspeakWorker() {
  if (_espeakWorker) return _espeakWorker;
  const espeakInit = (await import('@echogarden/espeak-ng-emscripten')).default;
  _espeakModule = await espeakInit();
  _espeakWorker = new _espeakModule.eSpeakNGWorker();
  return _espeakWorker;
}

function readEspeakPtr(ptr) {
  const p0 = ptr?.ptr || ptr;
  if (typeof p0 !== 'number') return '';
  let end = p0;
  while (_espeakModule.HEAPU8[end] !== 0 && end < p0 + 500) end++;
  return new TextDecoder('utf-8').decode(_espeakModule.HEAPU8.slice(p0, end));
}

// Map country code to eSpeak voice
const ESPEAK_VOICES = {
  AU: 'en',       // No specific AU voice — use default English
  UK: 'en-gb',
  US: 'en-us',
  CA: 'en-us',
  NZ: 'en',
  IE: 'en',
  ZA: 'en',
};

/**
 * Generate pronunciation using eSpeak-NG rule-based synthesis.
 * 100% coverage but unreliable for irregular/indigenous names.
 *
 * @returns {Promise<{ cmu: string, espeak: string, source: string } | null>}
 */
export async function lookupEspeak(placeName, country = 'AU') {
  try {
    const worker = await getEspeakWorker();
    const voice = ESPEAK_VOICES[country] || 'en';
    worker.set_voice(voice, '', 0);
    const ptr = worker.convert_to_phonemes(placeName);
    const espeakPhonemes = readEspeakPtr(ptr);
    if (!espeakPhonemes) return null;
    const cmu = espeakToCmu(espeakPhonemes);
    return { cmu, espeak: espeakPhonemes, source: `espeak:${voice}` };
  } catch (e) {
    return null;
  }
}

// ─── Cross-reference ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} PronunciationResult
 * @property {string} name - Place name
 * @property {string} country - Country code
 * @property {string} cmu - Best CMU ARPAbet pronunciation
 * @property {string} source - Which source provided the chosen pronunciation
 * @property {string} confidence - 'override' | 'multi-source' | 'single-source' | 'none'
 * @property {Object} sources - All source results
 * @property {string[]} conflicts - Description of any conflicts between sources
 */

/**
 * Gather pronunciation from all sources and cross-reference.
 *
 * Priority: override > multi-source agreement > Wikipedia > CMU dict
 *
 * @param {string} name - Place name
 * @param {string} country - Country code (AU, UK, US, CA, NZ, etc.)
 * @param {string} [disambiguation] - Wikipedia disambiguation (e.g. "New South Wales")
 * @returns {Promise<PronunciationResult>}
 */
export async function gatherPronunciation(name, country, disambiguation) {
  const result = {
    name,
    country,
    cmu: null,
    source: null,
    confidence: 'none',
    sources: {},
    conflicts: [],
  };

  // 1. Manual override (highest priority)
  const override = lookupOverride(name, country);
  if (override) {
    result.sources.override = override;
  }

  // 2. CMU dictionary
  const cmuEntries = lookupCmu(name);
  if (cmuEntries) {
    result.sources.cmu = cmuEntries[0]; // primary variant
  }

  // 3. Wikipedia
  const wiki = await lookupWikipedia(name, disambiguation || countryToDisambiguation(country));
  if (wiki) {
    result.sources.wikipedia = wiki;
  }

  // 4. eSpeak-NG (fallback — rule-based, 100% coverage)
  const espeak = await lookupEspeak(name, country);
  if (espeak) {
    result.sources.espeak = espeak;
  }

  // ── Choose best pronunciation ──────────────────────────────────────────

  // Override always wins
  if (override) {
    result.cmu = override.cmu;
    result.source = override.source;
    result.confidence = 'override';
    return result;
  }

  // If both CMU and Wikipedia agree (normalised), high confidence
  if (cmuEntries && wiki) {
    const cmuNorm = normaliseCmu(cmuEntries[0].cmu);
    const wikiNorm = normaliseCmu(wiki.cmu);
    if (cmuNorm === wikiNorm) {
      result.cmu = cmuEntries[0].cmu;
      result.source = 'cmu+wikipedia';
      result.confidence = 'multi-source';
      return result;
    }
    // Sources disagree — flag conflict
    result.conflicts.push(
      `CMU: ${cmuEntries[0].cmu} vs Wikipedia (${wiki.ipa}): ${wiki.cmu}`
    );
  }

  // For non-US countries, prefer Wikipedia over CMU (CMU is American English)
  if (country !== 'US' && wiki) {
    result.cmu = wiki.cmu;
    result.source = wiki.source;
    result.confidence = 'single-source';
    if (cmuEntries) {
      result.conflicts.push(
        `Using Wikipedia for ${country} (CMU is American English): CMU=${cmuEntries[0].cmu}, Wiki=${wiki.cmu}`
      );
    }
    return result;
  }

  // For US, prefer CMU dict (it's authoritative for American English)
  if (country === 'US' && cmuEntries) {
    result.cmu = cmuEntries[0].cmu;
    result.source = 'cmu';
    result.confidence = 'single-source';
    if (wiki) {
      result.conflicts.push(
        `Using CMU for US: CMU=${cmuEntries[0].cmu}, Wiki=${wiki.cmu}`
      );
    }
    return result;
  }

  // Fall back to whatever we have
  if (wiki) {
    result.cmu = wiki.cmu;
    result.source = wiki.source;
    result.confidence = 'single-source';
  } else if (cmuEntries) {
    result.cmu = cmuEntries[0].cmu;
    result.source = 'cmu';
    result.confidence = 'single-source';
  } else if (espeak) {
    result.cmu = espeak.cmu;
    result.source = espeak.source;
    result.confidence = 'espeak'; // flagged for review — rule-based, may be wrong
  }

  return result;
}

/**
 * Normalise CMU for comparison — strip stress numbers, lowercase.
 */
function normaliseCmu(cmu) {
  return cmu.replace(/[012]/g, '').trim().toLowerCase();
}

/**
 * Map country code to Wikipedia disambiguation suffix.
 */
function countryToDisambiguation(country) {
  const map = {
    AU: 'New South Wales',  // most of our AU suburbs are NSW — caller can override
    UK: 'England',
    US: null,               // US place names usually don't need disambiguation
    CA: 'Canada',
    NZ: 'New Zealand',
    IE: 'Ireland',
    ZA: 'South Africa',
  };
  return map[country] || null;
}

// ─── PLS generation ──────────────────────────────────────────────────────────

/**
 * Generate a PLS XML string from an array of pronunciation results.
 *
 * @param {PronunciationResult[]} results
 * @returns {string} PLS XML
 */
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
