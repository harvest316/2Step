# 2Step — TODO

## Phase 1: Today (Day 1)

- [x] Project scaffolding (package.json, DB, CLAUDE.md, .env)
- [x] Outscraper API integration
- [x] Video prompt generator (claude -p)
- [x] DM message generator (claude -p)
- [x] Email outreach wrapper (Resend)
- [x] Google Sheet sync (push/pull)
- [x] Architecture & pricing research documented
- [ ] npm install + init-db — verify everything works
- [ ] User: Sign up for Outscraper, get API key
- [ ] User: Find 10 prospects via Outscraper
- [ ] User: Generate video prompts, create 10 videos (InVideo + Holo)
- [ ] User: Upload videos to Drive, log URLs in DB via Sheet pull
- [ ] User: Generate DM messages, send emails, manually send DMs
- [ ] User: Sync to Google Sheet

## Phase 2: This Week — Platform Extraction + Automation

- [ ] Create mmo-platform monorepo with npm workspaces
- [ ] Extract @mmo/core (logger, error-handler, db, load-env, adaptive-concurrency)
- [ ] Extract @mmo/outreach (email, sms, form, spintax, compliance, outreach-guard)
- [ ] Extract @mmo/browser (stealth-browser, html-contact-extractor)
- [ ] Extract @mmo/monitor (cron framework, process-guardian, monitoring-checks.sh)
- [ ] Extract @mmo/orchestrator (claude-batch, orchestrator, claude-store)
- [ ] Update 333Method imports to @mmo/* packages
- [ ] Update 2Step imports to @mmo/* packages
- [ ] Creatomate API integration (src/video/creatomate.js)
- [ ] Pexels image search integration (PEXELS_API_KEY saved in .env) — fetch relevant background images per scene topic as backup if video tool needs supplied images
- [ ] Follow-up scheduler (Day 2/5/8 cadence)
- [ ] Outscraper review enrichment (Claude Max batch picks best review)
- [ ] Unified AFK overseer (mmo-platform/services/overseer/)
- [ ] Draft updated distributed-agent-system.md plan (DON'T refactor until approved)

## Phase 3: Later — Full Automation

- [ ] Claude orchestrator integration (2Step batch types)
- [ ] Full pipeline service (Outscraper → Creatomate → email → Sheet sync)
- [ ] auditandfix.com/video-reviews sub-page
- [ ] Cross-sell between Audit&Fix, 2Step, future projects
- [ ] A/B test animated GIF teaser (3-5s, <500KB via FFmpeg) vs static poster — measure CTR difference at scale
- [ ] Evaluate Loom / Vidyard / BombBomb for play-tracking on video emails

## Phase 4: Future

- [ ] Semi-automated DM sending via Playwright (after 2+ weeks manual patterns)
- [ ] InVideo/Holo automation via playwright-stealth
- [ ] Rotate Creatomate subtitle themes / template variants to avoid samey-looking videos at scale (post first paying customer)

## Validation Milestones

- [ ] Round 1 (Week 1): 30 free videos sent (10 per tool arm), measure response rate
- [ ] Round 2 (Weeks 2-4): 150 total sends, statistical confidence on tool choice
- [ ] First sale at $97 = proof of concept
- [ ] 5 sales from 150 videos (3.3% conversion) = validated business model
