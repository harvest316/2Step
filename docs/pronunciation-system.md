# Pronunciation System

Place name pronunciation for ElevenLabs TTS voiceovers.

## Architecture

```
Geonames bulk download
    ↓
data/gazetteers/{cc}.json            ← canonical place name lists per country
    ↓
scripts/gather-pronunciations.js     ← queries all sources, cross-references
    ↓  priority order:
    1. Manual overrides (data/pronunciation/overrides.json)
    2. Wikipedia MediaWiki API (IPA → CMU conversion)
    3. CMU Pronunciation Dictionary (135K US English, local file)
    4. eSpeak-NG WASM fallback (100% coverage, rule-based)
    ↓
data/pronunciation/results/{cc}.json ← all source data + confidence + conflicts
data/pronunciation/{cc}.pls          ← CMU ARPAbet PLS file
    ↓
scripts/upload-pls.js                ← uploads PLS to ElevenLabs
    ↓
data/pronunciation/.pls-dict-ids.json ← dict ID per country
    ↓
src/stages/video.js                  ← picks dict + voice per country at render time
```

## How it works at render time

1. `video.js` loads `.pls-dict-ids.json` at startup
2. For each site, `generateVoiceover(text, countryCode)` looks up the dict for that country
3. ElevenLabs receives voiceover text + the country's phoneme dictionary
4. When TTS encounters a place name (e.g. "Woollahra"), the CMU ARPAbet rule fires
5. Model must be `eleven_turbo_v2` or `eleven_flash_v2` — phoneme rules are silently dropped by `v2_5` and `multilingual_v2`

## Confidence levels

| Level | Meaning | Action needed |
|-------|---------|---------------|
| `override` | Human-verified in overrides.json | None |
| `multi-source` | Wikipedia + CMU dict agree | None |
| `single-source` | Only one authoritative source found | Spot-check |
| `espeak` | eSpeak rule-based only — no authoritative source | Review (may be wrong for irregular/indigenous names) |

## Fixing a wrong pronunciation

1. Find the correct IPA (Wiktionary, Wikipedia, local council sites, Forvo)
2. Convert to CMU ARPAbet using `src/video/ipa-to-cmu.js` or manually
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

# 2. Gather pronunciations from all sources
node scripts/gather-pronunciations.js --from-gazetteer {CC} --min-pop 5000

# 3. Review conflicts (optional but recommended)
# Check data/pronunciation/results/{cc}.json for entries with conflicts

# 4. Upload PLS to ElevenLabs
node scripts/upload-pls.js --country {CC}

# 5. Test — generate audio for a sample
# Pick 10-20 random entries, generate TTS, listen
node scripts/test-pronunciation-audio.js --country {CC} --sample 20

# 6. Fix any wrong pronunciations → add to overrides.json → repeat from step 2

# 7. Set country voice (optional)
# Add ELEVENLABS_VOICE_{CC}=<voice_id> to .env
# Default voices: AU=Charlie, UK=George, US=Roger (see src/video/elevenlabs-voices.js)
```

## ElevenLabs model compatibility

| Model | Alias rules | CMU phoneme rules | IPA phoneme rules |
|-------|-------------|-------------------|-------------------|
| `eleven_turbo_v2` | Yes | **Yes** | Silently dropped |
| `eleven_flash_v2` | Yes | **Yes** | Silently dropped |
| `eleven_turbo_v2_5` | Yes | Silently dropped | Silently dropped |
| `eleven_multilingual_v2` | Yes | Silently dropped | Silently dropped |
| `eleven_monolingual_v1` | Yes | Silently dropped | Silently dropped |

PLS file upload requires `content-type: text/xml` (not `application/pls+xml` — ElevenLabs rejects the correct MIME type).

## Source details

**Wikipedia MediaWiki API** — 200 RPM, IPA from `{{IPAc-en|...}}` templates. Best for irregular names. Coverage: ~5% of AU suburbs, higher for UK/US cities.

**CMU Pronunciation Dictionary** — 135K American English entries. Authoritative for US. Wrong for non-US countries (American accent). Local file at `data/pronunciation/cmudict.dict`.

**eSpeak-NG** — `@echogarden/espeak-ng-emscripten` npm package (WASM, no system binary). 100% coverage but rule-based — gets irregular/indigenous names wrong. Use `en-gb` for UK, `en-us` for US, `en` for others. Supports `mi` (Maori) for NZ.

**Manual overrides** — `data/pronunciation/overrides.json`. Highest priority. For names where all automated sources are wrong.

## Why one dict per country

A single global dict would cause cross-country collisions. For example:
- "Reading" UK = `R EH1 D IH0 NG` (like "red")
- "Reading" PA USA = `R IY1 D IH0 NG` (like "reed")

Per-country dicts isolate these correctly.

## Files

| File | Purpose |
|------|---------|
| `scripts/fetch-gazetteer.js` | Download Geonames place names per country |
| `scripts/gather-pronunciations.js` | Multi-source pronunciation gathering with checkpoint/resume |
| `scripts/upload-pls.js` | Upload PLS to ElevenLabs |
| `src/video/pronunciation-sources.js` | Source lookup functions + cross-reference logic |
| `src/video/ipa-to-cmu.js` | IPA → CMU ARPAbet converter |
| `src/video/espeak-to-cmu.js` | eSpeak phoneme notation → CMU ARPAbet converter |
| `src/video/elevenlabs-voices.js` | Country → voice ID mapping |
| `data/pronunciation/overrides.json` | Manual pronunciation corrections |
| `data/pronunciation/{cc}.pls` | Generated PLS files (CMU ARPAbet) |
| `data/pronunciation/.pls-dict-ids.json` | ElevenLabs dict IDs per country |
| `data/pronunciation/results/{cc}.json` | Full gather results with all source data |
| `data/pronunciation/cmudict.dict` | CMU Pronunciation Dictionary (local) |
| `data/gazetteers/{cc}.json` | Geonames place name lists per country |

## Decision

DR-148 in `~/code/mmo-platform/docs/decisions.md`.
