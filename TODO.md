# 2Step TODO

## Pending

### Re-research US unverified pronunciations (needs Claude Max tokens)
3,657 US place names are `unverified` because the researcher (previously on
OpenRouter) ran out of credits mid-gather. Researcher is now fixed to use
`claude -p` (Claude Max).

Add `--retry-unverified` flag to `scripts/gather-pronunciations.js` that:
1. Loads checkpoint, finds all entries where `confidence === 'unverified'`
2. Re-runs `researchPronunciation()` on each
3. Re-evaluates confidence and saves back to checkpoint
4. Re-uploads PLS after

Then run: `node scripts/gather-pronunciations.js --from-gazetteer US --retry-unverified`
and re-upload: `node scripts/upload-pls.js --country US --force`

### Split test: proofreading model (Opus vs Haiku vs Sonnet)
Currently using Opus for script proofreading. Run a split test comparing
Opus, Sonnet, and Haiku on ~50 scripts to measure: (a) catch rate for
real issues, (b) false positive rate, (c) latency, (d) cost if moved
off Claude Max to OpenRouter direct billing.

### Logo scraper: OCR-based logo selection
When multiple logo candidates are found (e.g. favicon + header logo + footer logo),
run quick OCR across each candidate and pick the one whose text best matches the
business name. Prevents selecting favicon-only logos that lack the company name.
Could use Tesseract.js or sharp-based text detection.

### Generate Kling clips — MEDIUM priority problems
Prompts written in `kling-batch-round9.js` (removed before commit). Re-add and run when credits available.

Each needs 5 hook + 5 treatment clips = 10 clips × 8 credits = 80 credits per problem.

**Pest control:**
- `ant` — common in AU (fire ants, carpenter ants, kitchen trails)
- `bed-bug` — common in urban areas

**Plumbing:**
- `gas-fitting` — gas hot water systems, cooktops, gas leaks

**House cleaning:**
- `carpet-floor` — steam cleaning, tile/grout, timber polishing

**Also:** 5th clip (e variant) for each HIGH priority pool once they're proven:
possum-hook-e, possum-treatment-e, general-pest-hook-e, general-pest-treatment-e,
toilet-hook-e, toilet-treatment-e, regular-clean-hook-e, regular-clean-treatment-e

Total: ~400 credits for all medium + 5th variants

### Wire new clip pools into CLIP_POOLS + review-criteria
After round 9 clips are generated:
1. Add `possum`, `general-pest`, `toilet`, `regular-clean` entries to `CLIP_POOLS` in `shotstack-lib.js`
2. Add Outscraper search terms to `data/review-criteria/AU/*.json`
3. Add `PROBLEM_SHARED_POOL` mappings
4. Add `NICHE_ALIASES` entries where needed
5. Update `buildScenes()` hook text for new problems

### Plumber + house cleaning verticals (prospects 17–37)
Sites 16–37 are at `video_created`. `problem_category` and `selected_review_json` are
now populated. Remaining before outreach:
1. Generate Kling clips for missing plumber/cleaning sub-niches (see "Wire new clip pools" above)
2. Re-render videos with updated pipeline (per-country voice, PLS dicts, proofreader)
   — reset status to `enriched` when clips are ready

### Email infrastructure: migrate to SES at scale (DR-126)
Revisit when sustained volume hits 5k emails/month or production bounce/complaint rate >2%.
SES advantages: cleaner shared IP pool, dedicated IPs at $24.95/mo (vs Resend $40/mo), ~4x cheaper per email.
Migration work: AWS sandbox approval, SNS bounce/complaint webhooks, SDK swap.

### Global expansion: populate state_abbreviations for active markets
When expanding outreach beyond AU, update the `countries` table
(`db/migrations/016-create-countries-table.sql`) with state/province
abbreviations for each target market so the voiceover name-cleaner can
strip them correctly.

Countries already populated: AU (8 states/territories), US (51 incl. DC),
CA (13 provinces/territories), IN (37 states/UTs), MX (32 states).

Countries intentionally empty (no state in Google Maps business names):
GB, IE, NZ, ZA, SG, and all European/Asian markets in the table.

Before going live in a new country:
1. Check whether Google Maps business listings in that country append
   state/region abbreviations to business names (common in AU, US, CA).
2. If yes, add the list to `state_abbreviations` in `016-create-countries-table.sql`
   and re-run the migration on the target DB.
3. Run `scene-builder.test.js` (115 tests) to confirm no regressions.

### Video quality fixes
- ~~Quote selection: sentences starting with subordinate clauses still pass occasionally~~ — fixed (extended DANGLING_OPENERS)
- ~~CTA slide subtitle: remove business name when logo is present~~ — already handled in code
- ~~Voiceover rising intonation on exclamation sentences~~ — fixed (! → . in smoothGrammar)
- Short reviews (sites 1, 3, 6, 8): re-fetch longer reviews from Outscraper
  **BLOCKED**: no `google_place_id` on any site, `refetch-reviews.js` uses old SQLite DB.
  Fix: (1) populate `google_place_id` from original Outscraper import, (2) migrate script to PG
