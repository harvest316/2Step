# 2Step TODO

## Pending

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
Still at `found` status — no logos, no videos queued. When ready to expand:
1. Run logo scraper / prompt-generator for these prospects
2. Generate Kling clips for any missing plumber/cleaning sub-niches
3. Queue video renders

### Email infrastructure: migrate to SES at scale (DR-126)
Revisit when sustained volume hits 5k emails/month or production bounce/complaint rate >2%.
SES advantages: cleaner shared IP pool, dedicated IPs at $24.95/mo (vs Resend $40/mo), ~4x cheaper per email.
Migration work: AWS sandbox approval, SNS bounce/complaint webhooks, SDK swap.

### Video quality fixes
- Quote selection: sentences starting with subordinate clauses still pass occasionally
- CTA slide subtitle: remove business name when logo is present on that scene
- Voiceover rising intonation on exclamation sentences — consider SSML break
- Short reviews (sites 1, 3, 6, 8): re-fetch longer reviews from Outscraper
