# Pronunciation System

Place name pronunciation for ElevenLabs TTS voiceovers. Target: 3 independent sources agree on every pronunciation.

## Source Independence

Wikipedia, Wiktionary, and Wikidata are ONE editorial pool (98% of Wikidata P898 entries are unreferenced copy-pastes from other Wikimedia projects). CMU dict and ipa-dict share Wiktionary upstream. These cannot be counted as separate sources.

**Independent sources for agreement counting:**

| # | Source | Coverage | Counts? |
|---|--------|----------|---------|
| 1 | **Manual overrides** | Hand-curated | Bypasses (always wins) |
| 2 | **Wikimedia** (Wikipedia + Wiktionary + Wikidata as ONE) | ~5-30% | Yes |
| 3 | **CMU dict** (134K US English) | US/CA cities | Yes |
| 4 | **OpenStreetMap** (`name:pronunciation` tag) | ~735 places, mostly UK | Yes |
| 5 | **Opus web researcher** (on-demand, searches council/govt/tourism) | Any name | Yes |

## Architecture

```
Geonames bulk download
    ↓
data/gazetteers/{cc}.json            ← canonical place name lists per country
    ↓
scripts/gather-pronunciations.js     ← queries all sources, counts agreement
    ↓  independent sources:
    1. Manual overrides (bypass — always wins)
    2. Wikimedia (Wikipedia + Wiktionary + Wikidata combined)
    3. CMU Pronunciation Dictionary
    4. OpenStreetMap (Overpass API)
    5. Opus web researcher (if < 3 agree)
    ↓
data/pronunciation/results/{cc}.json ← all source data + confidence + conflicts
data/pronunciation/{cc}.pls          ← CMU ARPAbet PLS file
    ↓
scripts/upload-pls.js                ← uploads PLS to ElevenLabs
    ↓
data/pronunciation/.pls-dict-ids.json ← dict ID per country
    ↓
src/stages/video.js                  ← picks dict + voice per country at render time
                                        on-the-fly gather for unknown names
```

## How it works at render time

1. `video.js` loads `.pls-dict-ids.json` at startup
2. Before generating voiceover, checks if `site.city` is in the PLS
3. **If not found**: calls `gatherPronunciation()` with all sources + Opus researcher, appends to PLS, re-uploads to ElevenLabs
4. `generateVoiceover(text, countryCode)` sends text + country dict to ElevenLabs
5. Model must be `eleven_turbo_v2` or `eleven_flash_v2` — phoneme rules silently dropped by `v2_5` and `multilingual_v2`

## Confidence levels

| Level | Meaning | Action |
|-------|---------|--------|
| `override` | Human-verified in overrides.json | None |
| `verified` | 3+ independent sources agree | None |
| `likely` | 2 sources agree | Spot-check recommended |
| `single-source` | Only 1 authoritative source | Opus researcher should have run |
| `unverified` | No sources found | Needs manual override |

When automated sources give < 3 agreement, the **Opus web researcher** is triggered. It searches country-restricted queries for pronunciation on council, government, tourism, and news sites. Each web source it finds counts as an independent source.

## Fixing a wrong pronunciation

1. Find the correct IPA (Wiktionary, local council sites, Forvo)
2. Convert to CMU ARPAbet using `src/video/ipa-to-cmu.js` or `cmuToIpa()` for reverse
3. Add to `data/pronunciation/overrides.json`:
   ```json
   {
     "name": "Woollahra",
     "country": "AU",
     "cmu": "W UH1 L AA1 R AH0",
     "source": "manual:wiktionary",
     "note": "IPA /wʊˈlɑːrə/"
   }
   ```
4. Re-run gather: `node scripts/gather-pronunciations.js --from-gazetteer AU --min-pop 5000`
5. Re-upload: `node scripts/upload-pls.js --country AU --force`

## New country rollout

```bash
# 1. Download place names from Geonames
node scripts/fetch-gazetteer.js --country {CC}

# 2. Gather pronunciations (triggers Opus researcher for < 3 agreement)
node scripts/gather-pronunciations.js --from-gazetteer {CC} --min-pop 5000

# 3. Review conflicts
# Check data/pronunciation/results/{cc}.json for entries with conflicts

# 4. Upload PLS to ElevenLabs
node scripts/upload-pls.js --country {CC}

# 5. Test — generate audio for a sample, listen
node scripts/test-pronunciation-audio.js --country {CC} --sample 20

# 6. Fix wrong ones → add to overrides.json → repeat from step 2

# 7. Set country voice (optional)
# Add ELEVENLABS_VOICE_{CC}=<voice_id> to .env
# Default: AU=Charlie, UK=George, US=Roger (src/video/elevenlabs-voices.js)
```

## ElevenLabs model compatibility

| Model | Alias rules | CMU phoneme rules | IPA phoneme rules |
|-------|-------------|-------------------|-------------------|
| `eleven_turbo_v2` | Yes | **Yes** | Silently dropped |
| `eleven_flash_v2` | Yes | **Yes** | Silently dropped |
| `eleven_turbo_v2_5` | Yes | Silently dropped | Silently dropped |
| `eleven_multilingual_v2` | Yes | Silently dropped | Silently dropped |

PLS upload requires `content-type: text/xml` (not `application/pls+xml`).

## Source details

**Wikimedia** — Wikipedia `{{IPAc-en}}` templates, Wiktionary dialect-specific IPA (AusE, RP, GenAm), Wikidata P898. Queried as one combined source. Coverage: ~5% AU suburbs, ~30% UK/US cities.

**CMU Pronunciation Dictionary** — 134K American English entries. Authoritative for US. Wrong for non-US (American accent). Local file at `data/pronunciation/cmudict.dict`.

**OpenStreetMap** — Overpass API, `name:pronunciation` tag. ~735 places globally, mostly UK. Truly independent editors from Wikimedia.

**Opus web researcher** — On-demand. Searches council/govt/tourism websites for pronunciation via country-restricted web search. Each distinct web source counts as an independent source. This is what achieves 3-source agreement for suburb-level names that automated sources miss.

**Manual overrides** — `data/pronunciation/overrides.json`. Highest priority, bypasses agreement counting.

## Why one dict per country

Cross-country collisions: "Reading" UK = `R EH1 D IH0 NG` vs "Reading" PA USA = `R IY1 D IH0 NG`. Per-country dicts isolate correctly.

## Files

| File | Purpose |
|------|---------|
| `scripts/fetch-gazetteer.js` | Download Geonames place names per country |
| `scripts/gather-pronunciations.js` | Multi-source gathering with checkpoint/resume |
| `scripts/upload-pls.js` | Upload PLS to ElevenLabs |
| `src/video/pronunciation-sources.js` | Source lookups, agreement counting, Opus researcher |
| `src/video/ipa-to-cmu.js` | IPA ↔ CMU ARPAbet converter (both directions) |
| `src/video/elevenlabs-voices.js` | Country → voice ID mapping |
| `data/pronunciation/overrides.json` | Manual pronunciation corrections |
| `data/pronunciation/{cc}.pls` | Generated PLS files (CMU ARPAbet) |
| `data/pronunciation/.pls-dict-ids.json` | ElevenLabs dict IDs per country |
| `data/pronunciation/results/{cc}.json` | Full gather results with all source data |
| `data/pronunciation/cmudict.dict` | CMU Pronunciation Dictionary (local) |
| `data/gazetteers/{cc}.json` | Geonames place name lists per country |

## Decision

DR-148 in `~/code/mmo-platform/docs/decisions.md`.
