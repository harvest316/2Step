/**
 * Opus web researcher for place name pronunciations.
 *
 * When automated sources (Wikimedia, CMU, OSM) give < 3 agreeing results,
 * this module uses Claude via OpenRouter to web-search for the pronunciation
 * on council, government, tourism, and news sites.
 *
 * Each distinct web source found counts as an independent source for
 * the 3-source agreement model.
 */

import { ipaToCmu, cmuToIpa } from './ipa-to-cmu.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const COUNTRY_NAMES = {
  AU: 'Australia', UK: 'United Kingdom', US: 'United States',
  CA: 'Canada', NZ: 'New Zealand', IE: 'Ireland', ZA: 'South Africa',
};

/**
 * Research pronunciation via `claude -p` (Claude Max subscription).
 *
 * @param {string} name - Place name
 * @param {string} country - Country code
 * @param {string} state - State/region
 * @param {Array<{cmu: string, source: string}>} existingSources
 * @returns {Promise<Array<{cmu: string, ipa: string, source: string, note?: string}>>}
 */
export async function researchPronunciation(name, country, state, existingSources) {
  const countryName = COUNTRY_NAMES[country] || country;
  const existingIPA = existingSources
    .filter(s => s?.cmu)
    .map(s => `${s.source}: ${cmuToIpa(s.cmu) || s.cmu}`)
    .join('\n  ');

  const prompt = `Research the correct local pronunciation of the place name "${name}" in ${state || ''}, ${countryName}.

I already have these pronunciations from automated sources:
  ${existingIPA || '(none found)'}

Search for the pronunciation using country-restricted searches (${countryName} only):
- "${name} pronunciation" (restricted to ${countryName})
- "${name} pronunciation ${state || ''}" (restricted to ${countryName})
- "${name}" on local council, government, or tourism websites

For each source you find, return:
- The pronunciation in IPA (e.g. /wʊˈlɑːrə/) or CMU ARPAbet (e.g. W UH1 L AA1 R AH0)
- The source URL
- Whether this is an authoritative source (government, council, university) or informal (forum, blog)
- The format: "ipa" or "cmu"

ONLY accept pronunciations in IPA or CMU ARPAbet format. Ignore informal respellings like "wul-AH-ra", "KAIRNS", "mel-BURN" — these are NOT valid phonetic data.

IMPORTANT: You MUST return ONLY a valid JSON array — no prose, no markdown, no code fences. Example format:
[{"pronunciation": "/wʊˈlɑːrə/", "format": "ipa", "source": "https://example.com/page", "authoritative": true, "note": "City council pronunciation guide"}]

Rules:
- "source" must be a full URL string, not a domain name
- "pronunciation" must be IPA (in slashes) or CMU ARPAbet (space-separated uppercase with stress numbers)
- "format" must be "ipa" or "cmu"
- Do NOT include informal respellings, only IPA or CMU
- Do NOT include URLs without pronunciation data
- If you cannot find any IPA or CMU data, return exactly: []`;

  try {
    const { stdout, stderr } = await execFileAsync('claude', ['-p', prompt], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });

    if (stderr) console.warn(`  Researcher stderr: ${stderr.slice(0, 200)}`);
    const response = stdout.trim();

    // Parse JSON from response — handle markdown fences and extra text
    let jsonStr = response;
    // Strip markdown code fences
    jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    // Find the JSON array
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    let findings;
    try {
      findings = JSON.parse(jsonMatch[0]);
    } catch {
      // Try to extract individual objects if the array parse fails
      const objMatches = jsonStr.match(/\{[^{}]*"ipa"\s*:\s*"[^"]+?"[^{}]*\}/g);
      if (!objMatches) return [];
      findings = objMatches.map(m => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);
    }
    return findings
      .filter(f => f.pronunciation || f.ipa) // accept both old and new field names
      .map(f => {
        const raw = f.pronunciation || f.ipa || '';
        const format = f.format || (raw.match(/^[A-Z]{2}/) ? 'cmu' : 'ipa');
        let cmu;

        if (format === 'cmu') {
          // Validate: CMU should be space-separated uppercase phonemes with stress digits
          if (!/^[A-Z]{1,3}[012]?(\s+[A-Z]{1,3}[012]?)*$/.test(raw.trim())) return null;
          cmu = raw.trim();
        } else {
          const ipa = raw.replace(/^\/|\/$/g, '');
          // Reject informal respellings: must contain at least one IPA-specific character
          if (!/[ˈˌːɑæɒʌəɛɜɪʊɔŋʃʒθðɡɹɾ]/.test(ipa)) return null;
          cmu = ipaToCmu(ipa);
        }

        if (!cmu) return null;
        return {
          cmu,
          ipa: format === 'ipa' ? raw.replace(/^\/|\/$/g, '') : undefined,
          source: `research:${f.source || 'web'}`,
          note: f.note,
          authoritative: f.authoritative,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.warn(`  Researcher error: ${e.message}`);
    return [];
  }
}

