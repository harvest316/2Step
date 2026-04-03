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

const COUNTRY_NAMES = {
  AU: 'Australia', UK: 'United Kingdom', US: 'United States',
  CA: 'Canada', NZ: 'New Zealand', IE: 'Ireland', ZA: 'South Africa',
};

const COUNTRY_DOMAINS = {
  AU: '.au', UK: '.uk', US: '.gov,.edu', CA: '.ca', NZ: '.nz', IE: '.ie', ZA: '.za',
};

/**
 * Research pronunciation via Claude web search (OpenRouter).
 *
 * @param {string} name - Place name
 * @param {string} country - Country code
 * @param {string} state - State/region
 * @param {Array<{cmu: string, source: string}>} existingSources
 * @returns {Promise<Array<{cmu: string, ipa: string, source: string, note?: string}>>}
 */
export async function researchPronunciation(name, country, state, existingSources) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('  OPENROUTER_API_KEY not set — skipping researcher');
    return [];
  }

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
- The IPA pronunciation (e.g. /wʊˈlɑːrə/)
- The source URL
- Whether this is an authoritative source (government, council, university) or informal (forum, blog)

IMPORTANT: Return your findings as a JSON array and nothing else:
[{"ipa": "/wʊˈlɑːrə/", "source": "https://example.com/...", "authoritative": true, "note": "City council pronunciation guide"}]

If you cannot find any pronunciation data, return exactly: []`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://auditandfix.com',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        // OpenRouter supports web search via plugins
        plugins: [{ id: 'web' }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  Researcher API error ${res.status}: ${err.slice(0, 200)}`);
      return [];
    }

    const data = await res.json();
    const response = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const findings = JSON.parse(jsonMatch[0]);
    return findings
      .filter(f => f.ipa)
      .map(f => {
        const ipa = f.ipa.replace(/^\/|\/$/g, '');
        return {
          cmu: ipaToCmu(ipa),
          ipa,
          source: `research:${f.source || 'web'}`,
          note: f.note,
          authoritative: f.authoritative,
        };
      })
      .filter(f => f.cmu);
  } catch (e) {
    console.warn(`  Researcher error: ${e.message}`);
    return [];
  }
}
