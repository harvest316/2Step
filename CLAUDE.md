# CLAUDE.md — 2Step Video Review Outreach

## Project Overview

2Step finds local businesses with strong Google reviews, creates a free 30-45s AI video from their best review, and sends it as cold outreach. Close: $625 setup + $99/month retainer.

**Pipeline:** Prospect (import CSV / reviews stage) → Video Prompt (claude -p) → Video Creation (manual/Creatomate) → 8-Touch Outreach Sequence (28 days) → Close

## Architecture

2Step is a **child project** of the mmo-platform parent. See `docs/architecture.md` for full details.

**Today's bridge:** Imports shared modules from 333Method via `file:` dep (`"333method": "file:../333Method"`). Will migrate to `@mmo/*` packages when `mmo-platform` is extracted.

## Development Commands

- `npm run init-db` — Initialize/reset SQLite database
- `npm run prospect:import` — Import prospects from CSV
- `npm run video:prompts` — Generate video prompts via claude -p
- `npm run outreach:dm` — Generate DM messages via claude -p

## Database

SQLite at `db/2step.db`. Schema in `db/schema.sql`.

**Status flow:** found → reviews_downloaded → enriched → video_created → proposals_drafted → outreach_sent → replied → interested/closed/not_interested

**Tables:** sites, videos, keywords, niche_tiers (+ msgs.messages in shared DB)

**Outreach sequence (8 touches over 28 days):**
| Touch | Day | Channel | Value angle |
|-------|-----|---------|-------------|
| 1 | 0 | Email | Initial outreach: free video demo hook |
| 2 | 2 | SMS | Heads-up nudge: cross-channel coordination |
| 3 | 5 | Email | ROI data: video reviews drive 2x enquiries |
| 4 | 8 | Email | Video view signal branch (viewed vs not viewed) |
| 5 | 12 | SMS | Social proof: businesses in their city |
| 6 | 16 | Email | Case study: full package preview with pricing |
| 7 | 21 | Email | SEO/Google ranking benefits |
| 8 | 28 | Email | Breakup: closing the file, leave door open |

Sequence stops automatically if prospect replies. Templates per country in `data/templates/{AU,UK,US,CA,NZ}/sequence.json`.

## Key Files

- `src/prospect/import-csv.js` — Import prospects from CSV
- `src/video/prompt-generator.js` — Video script generation via claude -p
- `src/stages/proposals.js` — 8-touch sequence proposal generator (spintax templates)
- `src/stages/outreach.js` — Email/SMS sender (cadence-aware, stops on reply)
- `scripts/2step-batch.js` — Batch job dispatcher (sequence_check queues due touches)
- `data/templates/{CC}/sequence.json` — Country-specific 8-touch templates
- `db/migrations/011-add-sequence-columns.sql` — Adds sequence_step + scheduled_send_at
- `prompts/VIDEO-PROMPT.md` — Video prompt template

## Environment

- `.env` — Project config (see `.env.example`)
- `src/utils/load-env.js` loads in order: `.env` → `../333Method/.env.secrets` → `../333Method/.env`
- Phase 2: move all shared secrets to `../mmo-platform/.env.secrets`

## API Notes

**Creatomate** (`src/video/creatomate.js`): Template `f328161b-15d5-4e23-881c-6eb595536bce`
("AI-Generated Story", 9:16). Modifications: `Image-N.source` (Stability AI) + `Voiceover-N.source` (ElevenLabs).
6 scenes: Hook → 3× review chunks → Attribution → CTA.

## Current State (2026-03-10)

- 15 prospects in DB (pest control, Sydney) — all status='found'
- Google Sheet populated with all 15 via `npm run sheets:push`
- Next: generate video prompts → create videos → outreach

## Quality

- Run `npm test` before committing
- Never commit secrets or DB files
- Use `/tmp/test-logs` for test log output (not `./logs/`)

## Documentation

- `docs/architecture.md` — Platform architecture decisions
- `docs/pricing-research.md` — Video tool comparisons, cost estimates, validation plan
- `docs/TODO.md` — Project-specific tasks
