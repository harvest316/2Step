---
title: Pricing & Tool Research
category: business
created: 2026-03-10
status: active
---

# Pricing & Tool Research

Research conducted 2026-03-10 for tool selection, cost estimation, and validation planning.

## Video Creation Tools — Comparison

| Platform | Monthly Cost | Videos/Month (30s) | Cost/Video | API? | Stock Footage | AI Voiceover | Vertical 9:16 | Self-contained? |
|----------|-------------|-------------------:|-----------|------|---------------|--------------|---------------|-----------------|
| **Fliki Standard** | $21/mo (annual) | ~360 | $0.06 | Zapier/Make only | Included | 2,000+ voices included | Yes | ✅ Yes |
| **Shotstack** | ~$50/mo (Starter) | ~250 | $0.20 | Full REST API | Not included | Native TTS included | Yes | ✅ Yes (native TTS/images built-in; ElevenLabs/Stability optional upgrades billed via Shotstack) |
| **Creatomate** | $54/mo (Pro) + extras | ~550 renders | **$0.46** | Full REST API | Via Pexels (free) | ❌ Requires ElevenLabs key | Yes | ❌ No — requires separate ElevenLabs ($11/mo min + ~$0.15/video) + Stability AI (~$0.21/video) |
| **InVideo AI Max** | $50/mo | ~50-100 (manual) | $0.50-1.00 | No API* | Included (AI-selected) | Included (AI) | Yes | ✅ Yes |
| **Holo** | $19-39/mo | Opaque credits | ~$0.50+ | No API* | Limited | Included | Yes | ✅ Yes |
| **Synthesia** | $89/mo | ~30 (10 min) | $2.97/min | Yes | Limited | AI Avatar | Yes | ✅ Yes |

### Creatomate True Cost Breakdown (updated 2026-03-10)

Creatomate requires you to bring your own API keys (configured in their portal):

| Component | Provider | Cost/video |
|-----------|----------|-----------|
| Render | Creatomate Pro | ~$0.10 |
| Voiceover (~500 chars) | ElevenLabs Creator ($11/mo min) | ~$0.15 |
| Images (6 × Stability AI Core) | Stability AI PAYG | ~$0.18 |
| **Total** | | **~$0.43–$0.46** |

Plus fixed overhead: ElevenLabs Creator plan $11/mo (required just to get API access).

### Key Insights

- **InVideo/Holo** produce the highest-quality "AI-generated" videos but have no API
- **Fliki** is the new automation winner — $0.06/video, fully self-contained, 2,000+ voices, stock footage included, no external keys
- **Creatomate** dropped — advertised at $0.10/video but true cost is ~$0.46/video once ElevenLabs + Stability AI are factored in
- **Shotstack** self-contained (native TTS + image generation included) but no stock footage library — you supply media or use its Create API

### Automation Path for InVideo/Holo

Neither has a public API, but both are standard web apps (type prompt → generate → download). Automatable later with playwright-stealth: navigate, type prompt, click generate, poll for completion, download.

- InVideo uses Cloudflare but once logged in, interaction is just typing and clicking (same pattern as 333Method's form.js)
- Holo is less well-known, potentially less bot detection
- **Strong chance of automation later** — manual for now to validate first

### Recommendation

**Fliki** for API automation (Phase 2) — cheapest at $0.06/video, fully self-contained, no external key dependencies.
Keep InVideo + Holo subscriptions for manual split test batches.

### Split Test Plan

- **Arm A: InVideo AI** (manual, highest quality)
- **Arm B: Holo** (manual, AI-style)
- **Arm C: Fliki API** (automated, slideshow-style) — Phase 2 (replaces Creatomate)

If Arm C response rate is within 50% of A/B, automation wins on volume. If A/B dramatically outperforms, automate InVideo via Playwright later.

### Sign-ups

- **Outscraper:** Free tier (25 free requests), then pay-as-you-go ($3/1K results)
- **InVideo AI Max:** $50/mo (full month for validation)
- **Holo:** $19-39/mo (full month for validation)
- **Fliki Standard:** $21/mo (API automation, Phase 2 — replaces Creatomate)

Validation month subscription cost: InVideo ($50) + Holo ($39) + Fliki ($21) = **$110 total** (down from $143).

---

## Prospect Data — Outscraper vs Alternatives

| Platform | Pricing | Google Maps Results | Reviews API | API Quality | Best For |
|----------|---------|--------------------:|-------------|-------------|----------|
| **Outscraper** | ~$3/1K results, $2/1K reviews | Full business data + contacts + social | Separate API call | Clean REST, JSON | Best value for our volume |
| **SerpApi** | $50/mo (5K searches) | Google Maps pack only | No reviews API | Good REST | SERP results, not Maps data |
| **DataForSEO** | $0.10/task (~$100/1K) | Full Google Maps | Has reviews | Good REST | Already have account |
| **Apify** | $49/mo (actors) | Via community actors | Via actors | Varies | Flexibility, less reliable |

### Why Outscraper

- Cheapest at volume ($3/1K vs $100/1K for DataForSEO)
- Purpose-built for Google Maps data
- Handles ToS risk (they're the data processor)
- Clean REST API returns structured JSON (name, rating, reviews, contacts, social links)
- Includes reviews API

### Why NOT Direct Google Maps Scraping

- Google Maps has aggressive bot detection
- ToS risk falls on us instead of the data provider
- Outscraper moves that risk away

---

## Volume Estimates at Scale

Based on $1,500/week revenue target at $97/video:

| Metric | Conservative (3%) | Optimistic (8%) |
|--------|-------------------|-----------------|
| Target revenue | $1,500/week | $1,500/week |
| Sales needed/week | 16 | 16 |
| Conversion rate | 3% | 8% |
| **Outreaches needed/week** | **533** | **200** |
| **Outreaches/day** | **76** | **29** |
| **Videos/month** | **~2,300** | **~870** |
| **Prospects/month** | **~2,300** | **~870** |

---

## Cost Summary at Scale

| Line Item | Conservative | Optimistic |
|-----------|-------------|-----------|
| Prospects (Outscraper) | $6.90/mo | $2.61/mo |
| Videos (Fliki Standard) | $21/mo (flat) | $21/mo (flat) |
| Emails (Resend) | ~$5/mo | ~$2/mo |
| Video hosting (R2) | ~$1/mo | ~$1/mo |
| **Total operating cost** | **~$34/mo** | **~$27/mo** |
| **Monthly revenue** | **$6,000/mo** | **$6,000/mo** |
| **Margin** | **99.4%** | **99.6%** |

Fliki's flat $21/mo covers ~360 videos/month — well within the conservative volume estimate (~2,300/mo at scale would require a higher Fliki tier or switching to per-render pricing). At validation scale (<100 videos/mo), $21/mo is more than sufficient.

_Note: Previous table used Creatomate at $0.10/video ($87-$230/mo) — that figure excluded ElevenLabs and Stability AI costs. True Creatomate cost would have been ~$0.46/video ($200-$530/mo)._

---

## Video-in-Email: Thumbnail + Link

**Video cannot be embedded in email.** Gmail and Outlook (60%+ market share) strip HTML5 `<video>` tags.

**Industry standard approach:**
- Email contains a **thumbnail image with fake play button overlay** → clicks through to hosted video page
- Thumbnail emails average **10.3% CTR** vs 6.1% for static images
- No YouTube/Vimeo premium needed — self-host on R2 ($0.015/GB/mo) or use free YouTube unlisted links

**Don't attach videos to emails:**
- Resend limit: 40MB per email (after Base64 encoding)
- A 30s 1080p video = 5-30MB raw, +33% for Base64 = 7-40MB (right at the limit)
- Large attachments destroy deliverability — spam filters penalize heavy emails
- Always link, never attach

**Video hosting plan:**
- Day 1: Google Drive shareable links (free, zero setup)
- At scale: R2 with a `video.` CNAME on `BRAND_DOMAIN` ($0.015/GB/mo)

**For DMs (Instagram/Facebook):** Share Google Drive link directly. Some platforms allow video upload in DMs.

---

## Validation Plan

### Round 1 — Validate Demand (Week 1)

- Sign up for full monthly subscriptions: InVideo AI Max ($50/mo), Holo ($19-39/mo), Creatomate Pro ($54/mo)
- Create 10 videos per tool (30 total) — assess quality, speed, workflow friction
- Test video delivery: thumbnail+link in email, Google Drive link in DMs
- Send all 30 as free demos to businesses with 5-star reviews
- **Key question:** Do businesses actually want these?
- **Kill criteria:** If <5% of recipients respond positively after 30 sends, the "wow factor" assumption is weak — but continue to Round 2 for proper sample size

### Round 2 — Statistical Confidence (Weeks 2-4)

- Scale to **50 videos per tool arm** (150 total sends) over remaining 3 weeks
- At 3-8% expected response rate, 50 sends/arm gives 1.5-4 responses per arm
- Track per-arm: response rate, click-through rate, tone of replies
- **Combined across all arms:** 150 sends at 5% = ~8 positive responses — meaningful signal
- Test pricing with responders: offer $97 individual video
- If $97 converts, test $297/mo package
- **Target:** >=5 sales from 150 videos (3.3% conversion)
- **Tool decision:** After 150 sends, compare response rates. If Creatomate (automated) within 50% of best manual tool, automation wins on volume

### Pricing Strategy

- Test $97/video first (lower friction, faster validation)
- Upsell to $297/mo packages for repeat buyers
- Master briefing target: $625 setup + $99/mo retainer (test after proving $97 demand)

---

## Outreach Channel Priority

| Priority | Channel | Day 1? | Notes |
|----------|---------|--------|-------|
| 1 | Email | Yes (automated) | Resend, CAN-SPAM compliant, most reliable |
| 2 | Manual DMs | Yes (copy-paste) | Instagram/Facebook, LLM-generated messages |
| 3 | Contact form | No | Reuse 333Method's form.js later |
| 4 | Semi-automated DMs | Phase 4 | After 2+ weeks manual DM patterns established |

**Meta DM automation deferred:** Instagram/Facebook have aggressive bot detection. Manual only until email channel is proven and manual DM patterns are established (2+ weeks).

## DM Message Strategy

- **Small volume (<50/day):** LLM-generated per message via `claude -p` (zero cost on Claude Max). Each message is genuinely unique — better quality than spintax
- **Scale-up (>50/day):** Switch to spintax templates. Reuse 333Method's `src/utils/spintax.js` (260 lines: `spin()`, `generateVariations()`, `seededRandom()`)
