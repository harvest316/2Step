# CLAUDE.md — 2Step Video Review Outreach

## Project Overview

2Step finds local businesses with strong Google reviews, creates a free 30-45s AI video from their best review, and sends it as cold outreach. Close: $625 setup + $99/month retainer.

**Pipeline:** Prospect (import CSV / reviews stage) → Video Prompt (claude -p) → Video Creation (manual/Creatomate) → Outreach (email + DMs) → Follow-up → Close

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

**Status flow:** found → video_prompted → video_created → outreach_sent → followup_1 → followup_2 → followup_3 → interested/closed/not_interested

**Tables:** prospects, videos, outreaches, followups, conversations

## Key Files

- `src/prospect/import-csv.js` — Import prospects from CSV
- `src/video/prompt-generator.js` — Video script generation via claude -p
- `src/outreach/dm-generator.js` — LLM-generated DM messages
- `src/stages/outreach.js` — Email/DM outreach stage (supersedes old email.js)
- `prompts/VIDEO-PROMPT.md` — Video prompt template
- `prompts/DM-OUTREACH.md` — DM outreach prompt template

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
