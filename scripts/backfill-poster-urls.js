#!/usr/bin/env node

/**
 * backfill-poster-urls — One-time backfill.
 *
 * Re-pushes all sites with a video_hash to api.php?action=store-video,
 * now including poster_url. Fixes the p.php 404 caused by poster_url
 * not being stored in the original push.
 *
 * Usage:
 *   node scripts/backfill-poster-urls.js [--dry-run]
 */

import '../src/utils/load-env.js';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BRAND_URL = (process.env.BRAND_URL || '').replace(/\/$/, '');
const WORKER_SECRET = process.env.API_WORKER_SECRET || '';
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const { rows: sites } = await pool.query(`
    SELECT DISTINCT ON (s.id)
      s.id, s.video_hash, s.business_name, s.domain,
      s.video_url, s.niche, s.country_code, s.review_count,
      v.thumbnail_url as poster_url
    FROM twostep.sites s
    JOIN twostep.videos v ON v.site_id = s.id
    WHERE s.video_hash IS NOT NULL
      AND v.thumbnail_url IS NOT NULL
      AND v.thumbnail_url != ''
    ORDER BY s.id, v.id DESC
  `);

  console.log(`Found ${sites.length} sites to backfill${dryRun ? ' (dry-run)' : ''}`);

  let ok = 0, failed = 0;

  for (const site of sites) {
    const payload = {
      hash:         site.video_hash,
      video_url:    site.video_url,
      poster_url:   site.poster_url,
      business_name: site.business_name,
      domain:       site.domain,
      review_count: site.review_count,
      niche:        site.niche,
      country_code: site.country_code,
    };

    if (dryRun) {
      console.log(`  [dry] ${site.video_hash} -> ${site.business_name} (poster: ${site.poster_url})`);
      ok++;
      continue;
    }

    try {
      const res = await fetch(`${BRAND_URL}/api.php?action=store-video`, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-Auth-Secret':  WORKER_SECRET,
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`  [${site.video_hash}] HTTP ${res.status}: ${text.slice(0, 200)}`);
        failed++;
      } else {
        console.log(`  [${site.video_hash}] OK — ${site.business_name}`);
        ok++;
      }
    } catch (err) {
      console.error(`  [${site.video_hash}] Error: ${err.message}`);
      failed++;
    }
  }

  await pool.end();
  console.log(`\nDone: ${ok} pushed, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
