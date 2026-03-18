# Post-Payment Video Delivery Stage

## Concept

After a customer pays (setup + monthly), we enter a new pipeline stage
that creates X new videos per month using their remaining reviews.

## Requirements

- Download ALL 5-star reviews for the paying customer (not just the 1 qualifying review)
- Cycle through reviews by category so each video highlights a different service
- Generate and deliver X videos per month (per their plan: 4, 8, or 12)
- Track which reviews have been used (avoid repeats)
- Delivery method: email with video link + social media posting guide
- Consider: auto-post to their social accounts if they grant access

## Pipeline Changes Needed

- New status: `paid` -> `delivering` (ongoing video delivery)
- New table or column tracking `used_review_ids` per site
- Orchestrator batch type: `post_payment_videos`
- Two monthly cron tasks (already stubbed in `src/cron/`):
  1. `refresh-reviews.js` — re-download latest reviews for paying customers
     (new reviews may have come in since last download)
  2. `generate-customer-videos.js` — create videos from fresh/unused reviews,
     cycling through categories to keep videos diverse

## Trigger

Build this when first paying customer signs up.
