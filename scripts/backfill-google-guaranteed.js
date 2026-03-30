#!/usr/bin/env node

/**
 * backfill-google-guaranteed.js
 *
 * Backfills the `is_google_guaranteed` column for existing sites.
 *
 * Strategy (no Playwright, no live API calls):
 *
 *   1. Check `contacts_json` — if the stored scrape data contains a
 *      "google_guaranteed" or "is_google_guaranteed" field, use it.
 *
 *   2. Check `selected_review_json` / `all_reviews_json` — unlikely to contain
 *      badge info but checked as a fallback.
 *
 *   3. Check `google_maps_url` — if the URL embeds a place_id we can at least
 *      confirm we have no live data; the field stays 0 (unknown → not guaranteed).
 *
 *   4. For all remaining sites where no stored data indicates Google Guaranteed,
 *      set is_google_guaranteed = 0 explicitly (converts any NULL rows to 0).
 *
 * NOTE: The existing 15 CSV-imported prospects have no stored Outscraper data
 * (no contacts_json, no selected_review_json, no google_place_id). There is no
 * way to determine their Google Guaranteed status without a live Maps API call.
 * This script therefore marks all such sites as 0 (not detected / unknown).
 * When these sites are re-fetched via the reviews stage, `detectGoogleGuaranteed`
 * will correctly populate the column from the Outscraper response.
 *
 * Usage:
 *   node scripts/backfill-google-guaranteed.js
 *   node scripts/backfill-google-guaranteed.js --dry-run
 */

import '../src/utils/load-env.js';
import { parseArgs } from 'util';
import { getAll, run } from '../src/utils/db.js';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

const DRY_RUN = args['dry-run'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Attempt to detect Google Guaranteed from stored JSON blobs already in the DB.
 *
 * Outscraper returns `is_google_guaranteed` (bool/int) on the place object.
 * contacts_json is the most likely store for this if the enrichment stage
 * happened to persist the raw place data.
 *
 * @param {Object} site - DB row
 * @returns {{ detected: boolean, source: string, value: number }}
 */
function detectFromStoredData(site) {
  // contacts_json — enrichment stage sometimes stores partial place data here
  if (site.contacts_json) {
    try {
      const data = JSON.parse(site.contacts_json);
      // Check direct fields
      if (data.is_google_guaranteed !== undefined) {
        return { detected: true, source: 'contacts_json.is_google_guaranteed', value: data.is_google_guaranteed ? 1 : 0 };
      }
      if (data.google_guaranteed !== undefined) {
        return { detected: true, source: 'contacts_json.google_guaranteed', value: data.google_guaranteed ? 1 : 0 };
      }
      // Check nested place_data if present
      const place = data.place_data ?? data.place ?? data.maps_data ?? null;
      if (place) {
        if (place.is_google_guaranteed !== undefined) {
          return { detected: true, source: 'contacts_json.place_data.is_google_guaranteed', value: place.is_google_guaranteed ? 1 : 0 };
        }
        if (place.google_guaranteed !== undefined) {
          return { detected: true, source: 'contacts_json.place_data.google_guaranteed', value: place.google_guaranteed ? 1 : 0 };
        }
      }
    } catch {
      // malformed JSON — skip
    }
  }

  // selected_review_json and all_reviews_json typically don't carry badge data
  // but check anyway as a courtesy
  for (const field of ['selected_review_json', 'all_reviews_json']) {
    if (site[field]) {
      try {
        const data = JSON.parse(site[field]);
        if (data.is_google_guaranteed !== undefined) {
          return { detected: true, source: `${field}.is_google_guaranteed`, value: data.is_google_guaranteed ? 1 : 0 };
        }
        if (data.google_guaranteed !== undefined) {
          return { detected: true, source: `${field}.google_guaranteed`, value: data.google_guaranteed ? 1 : 0 };
        }
      } catch {
        // malformed JSON — skip
      }
    }
  }

  // No stored data available
  return { detected: false, source: 'none', value: 0 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill-gg] Starting Google Guaranteed backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const sites = await getAll(`
    SELECT id, business_name, is_google_guaranteed,
           contacts_json, selected_review_json, all_reviews_json,
           google_maps_url, google_place_id
    FROM sites
    WHERE is_google_guaranteed IS NULL OR is_google_guaranteed = 0
    ORDER BY id
  `);

  console.log(`[backfill-gg] Sites to check: ${sites.length}`);

  const stats = {
    total:          sites.length,
    already_zero:   0,   // was already 0 with no change possible
    detected_from_data: 0,  // found in stored JSON
    set_zero:       0,   // no data → explicitly set 0
    errors:         0,
  };

  for (const site of sites) {
    const { detected, source, value } = detectFromStoredData(site);

    if (detected && value === 1) {
      console.log(`[backfill-gg] site ${site.id} "${site.business_name}": GOOGLE GUARANTEED (source: ${source})`);
      if (!DRY_RUN) {
        try {
          await run(
            'UPDATE sites SET is_google_guaranteed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [site.id]
          );
        } catch (err) {
          console.error(`[backfill-gg] Failed to update site ${site.id}: ${err.message}`);
          stats.errors++;
          continue;
        }
      }
      stats.detected_from_data++;
    } else if (detected && value === 0) {
      // Stored data explicitly says not guaranteed — leave as 0 (already default)
      console.log(`[backfill-gg] site ${site.id} "${site.business_name}": not guaranteed (source: ${source})`);
      stats.already_zero++;
    } else {
      // No stored data to determine guarantee status
      // Site stays at 0 (the column default). Log which sites we couldn't check.
      const hasMapUrl  = !!site.google_maps_url;
      const hasPlaceId = !!site.google_place_id;
      const note = hasMapUrl || hasPlaceId
        ? `(has maps data, needs live re-fetch to confirm)`
        : `(CSV import, no stored Maps data — requires Outscraper re-fetch)`;
      console.log(`[backfill-gg] site ${site.id} "${site.business_name}": no stored data ${note}`);
      stats.set_zero++;
      // is_google_guaranteed is already 0 by default; no update needed
    }
  }

  console.log('\n[backfill-gg] Summary:');
  console.log(`  Total sites checked:    ${stats.total}`);
  console.log(`  Detected guaranteed:    ${stats.detected_from_data}`);
  console.log(`  Not guaranteed (data):  ${stats.already_zero}`);
  console.log(`  No stored data (→ 0):   ${stats.set_zero}`);
  console.log(`  Errors:                 ${stats.errors}`);

  if (stats.set_zero > 0) {
    console.log('\n[backfill-gg] NOTE: Sites with no stored Maps data cannot be backfilled.');
    console.log('  When these sites are re-fetched via the reviews stage, detectGoogleGuaranteed()');
    console.log('  will automatically populate is_google_guaranteed from the Outscraper response.');
  }

  if (DRY_RUN) {
    console.log('\n[backfill-gg] DRY RUN — no DB writes performed.');
  }
}

main().catch(err => {
  console.error('[backfill-gg] Fatal:', err.message);
  process.exit(1);
});
