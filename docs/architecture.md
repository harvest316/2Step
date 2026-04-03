---
title: Platform Architecture
category: architecture
created: 2026-03-10
status: active
---

# Platform Architecture: Parent-Child Design

## Overview

2Step is a **child project** within a parent-child platform architecture. The parent (`mmo-platform/`) provides shared services; child projects (`333Method/`, `2Step/`, future `GhostHunter/`) consume them.

One AFK session monitors everything, shared outreach/monitoring code benefits all projects, and new business ideas plug in without duplicating infrastructure.

## Package Scope: `@mmo/`

All shared packages are scoped under `@mmo/` ("make money online"):

- `@mmo/core` — logger, error-handler, db, config, load-env, adaptive-concurrency
- `@mmo/outreach` — email, sms, form, spintax, templates, sheets, compliance, outreach-guard
- `@mmo/browser` — stealth browser, profiles, html-contact-extractor, browser-notifications
- `@mmo/monitor` — cron framework, process guardian, AFK checks
- `@mmo/orchestrator` — claude batch runner, conservation mode

## Directory Structure

```
~/code/
  mmo-platform/                    # Parent: shared services (npm workspaces monorepo)
    package.json                   # { "workspaces": ["packages/*"] }
    packages/
      core/                        # @mmo/core
      outreach/                    # @mmo/outreach
      browser/                     # @mmo/browser
      monitor/                     # @mmo/monitor
      orchestrator/                # @mmo/orchestrator
    services/
      overseer/                    # Unified AFK monitoring across ALL child projects
      dashboard/                   # Unified dashboard (later)
    website/                       # Brand website — shared website
      index.php, api.php, o.php    # Sales pages, order forms, API endpoints
      workers/                     # Cloudflare Workers
    CLAUDE.md
    docs/TODO.md

  infra/                           # Infrastructure (renamed from 333Method-Infra)
    secrets/                       # SOPS-encrypted production secrets
    services.nix                   # NixOS service configs
    docs/plans/                    # Cross-project plans (distributed-agent-system.md)

  333Method/                       # Child: Audit&Fix website audits
  2Step/                           # Child: Video review outreach
  (future: GhostHunter/, etc.)
```

## Code Sharing Mechanism

npm workspaces in `mmo-platform/` manage packages. Child projects use `file:` protocol dependencies:

```json
// ~/code/2Step/package.json
{
  "dependencies": {
    "@mmo/core": "file:../mmo-platform/packages/core",
    "@mmo/outreach": "file:../mmo-platform/packages/outreach",
    "@mmo/browser": "file:../mmo-platform/packages/browser"
  }
}
```

Any improvement to a shared package benefits all child projects. No forking.

**Temporary bridge (Day 1):** Before mmo-platform extraction, 2Step uses `"333method": "file:../333Method"` to import shared modules directly. Replaced by `@mmo/*` packages this week.

## VSCode Multi-Root Workspace

All projects visible side-by-side via `~/code/mmo.code-workspace`:

```json
{
  "folders": [
    { "name": "Platform",  "path": "mmo-platform" },
    { "name": "Infra",     "path": "infra" },
    { "name": "333Method", "path": "333Method" },
    { "name": "2Step",     "path": "2Step" }
  ],
  "settings": {}
}
```

Open with: `File → Open Workspace from File → mmo.code-workspace`.

## Extraction Plan (Phase 2)

Modules to extract from `333Method/src/` into `mmo-platform/packages/`:

| Package | Modules from 333Method | ~Lines |
|---------|----------------------|--------|
| @mmo/core | logger.js, error-handler.js, db.js, load-env.js, adaptive-concurrency.js | 750 |
| @mmo/outreach | outreach/email.js, sms.js, form.js, spintax.js, compliance.js, outreach-guard.js, sheets-export.js | 2,800 |
| @mmo/browser | stealth-browser.js, html-contact-extractor.js, browser-notifications.js | 1,200 |
| @mmo/monitor | cron framework, process-guardian.js, monitoring-checks.sh | 1,000 |
| @mmo/orchestrator | claude-batch.js, claude-orchestrator.sh, claude-store.js | 1,600 |

333Method keeps: stages/, score.js, programmatic-scorer.js, proposal-generator-v2.js, site-filters.js, enrich.js, capture.js, and all business-specific code.

## Unified AFK Monitoring

One Claude Code session runs the overseer for ALL projects:

```
mmo-platform/services/overseer/
  projects.json          # Registry of all child projects (DB paths, log dirs, health checks)
  monitoring-checks.sh   # Iterates projects.json, runs project-specific health checks
  overseer.js            # Checks all projects, fixes blind spots
```

The existing `monitoring-checks.sh` already uses `PROJECT_DIR` env var — the unified version loops over registered projects.

## Database Strategy

Separate SQLite DB per project (`db/2step.db`, `db/sites.db`). Different data models; cross-query via `ATTACH` if needed. Each project owns its schema and migrations.

## Secrets Strategy

**Today:** 2Step loads shared secrets from `../333Method/.env.secrets` via load-env.js.

**Phase 2/3:** Move `.env.secrets` to `mmo-platform/.env.secrets` (centralized). All child projects load from there. Structured with foresight for distributed agents (secrets stay on the proxy/orchestrator host, child agents receive only virtual keys).

## GitHub Strategy

Unlimited private repos on Free plan. Separate repos for `mmo-platform`, `2Step`, keep `333Method` as-is. Each independently version-controlled.

## Clip Pipeline

AI-generated video clips are the core creative asset. The pipeline:

```
Kling AI → local clips/ → R2 (primary hosting) → B2 (backup)
```

### Storage

| Store | Purpose | Access |
|-------|---------|--------|
| `clips/` (local) | Working copy for tagging; deleted after focus-tagger session | Local only |
| Cloudflare R2 (`2step-clips`) | Primary public hosting — URLs embedded in Shotstack renders | Public CDN |
| Backblaze B2 (`2StepClipBackups`) | Offsite backup of all R2 clips | Private, us-east-005 |

### Clip Folder Structure (local)

```
clips/
  pest-control/
    cockroaches/   shared/      termites/
    rodents/       spiders/
  plumbing/
    blocked-drain/ burst-pipe/  hot-water/
    leaking-tap/   shared/
  house-cleaning/
    deep-clean/    dirty-bathroom/  end-of-lease/
    greasy-rangehood/  shared/
  focus-overrides.json   ← subtitle position per clip (top/bottom/center)
```

R2 stores clips flat (filename only, no subdirs) for clean public URLs.

### Scripts

| Script | Purpose |
|--------|---------|
| `src/video/kling-batch-round*.js` | Generate clips via Kling AI text-to-video |
| `src/video/focus-tagger.js` | Browser UI to tag subtitle position per clip |
| `src/video/r2-upload.js` | Upload local clips/ to R2 |
| `src/video/r2-download.js` | Download all CLIP_POOLS clips from R2 (for tagging) |
| `src/video/b2-backup.js` | Sync all CLIP_POOLS clips from R2 → B2 |
| `src/video/shotstack.js` | Render final video for a prospect via Shotstack |

### CLIP_POOLS

`shotstack-lib.js` exports `CLIP_POOLS` — curated pool of 174 clips across all verticals.
Each pool slot holds 5 clips (a–e), rotated per prospect via seed = prospect ID.

```
shared              → pest-control technician/resolution/cta (8 each)
plumbing-shared     → plumbing technician/resolution/cta (5 each)
house-cleaning-shared → house-cleaning technician/resolution/cta (5 each)
cockroaches/rodents/spiders/termites → hook + treatment (5 each)
blocked-drain/burst-pipe/leaking-tap/hot-water → hook + treatment (5 each)
greasy-rangehood/dirty-bathroom/end-of-lease/deep-clean → hook + treatment (5 each)
```

Focus overrides in `clips/focus-overrides.json` set subtitle position (top/bottom/center)
per clip. Tagged via `focus-tagger.js`, committed to git, loaded at render time.

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Shared code | Parent platform with npm workspaces | One place for shared code; improvements benefit all |
| Today's bridge | `file:../333Method` dep | Gets outreaches sent today without blocking on extraction |
| Database | Separate DB per project | Different data models; ATTACH for cross-query |
| AFK monitoring | One overseer for all projects | Single session watches everything via project registry |
| Secrets | Centralized in mmo-platform (Phase 2) | Foresight for distributed agents |
| VCS | Separate repos per project | Independent version control, clean git history |
| Clip hosting | R2 (primary) + B2 (backup) | R2 for fast CDN delivery; B2 for offsite backup at low cost |
| Clip rotation | Seed = prospect ID | Different clip combo per prospect, deterministic |
