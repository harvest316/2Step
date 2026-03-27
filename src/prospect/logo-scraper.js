#!/usr/bin/env node

/**
 * Logo scraper — fetches business logo URLs from their websites.
 *
 * Strategy (in priority order):
 *   1. JSON-LD Organization.logo.url       (WordPress/structured sites)
 *   2. <img> class/id/aria/alt = "logo"    (universal HTML pattern)
 *   3. <img> with "logo" in src filename   (common naming convention)
 *   4. <link rel="apple-touch-icon">       (higher-res than favicon)
 *   5. <link rel="apple-touch-icon">       (higher-res than favicon)
 *   6. og:image meta tag                   (their own image, often a hero/banner)
 *   7. Brandfetch API                      (third-party, only when all on-site signals fail)
 *   8. /favicon.ico                        (last resort, low quality)
 *
 * Stores result in sites.logo_url column.
 *
 * Usage:
 *   node src/prospect/logo-scraper.js           # All sites without logo_url
 *   node src/prospect/logo-scraper.js --id 1    # Specific site
 *   node src/prospect/logo-scraper.js --dry-run # Print URLs without saving
 *   node src/prospect/logo-scraper.js --force   # Re-scrape even if logo_url already set
 */

import '../utils/load-env.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import db from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    id: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
  strict: false,
});

function getSites() {
  if (args.id) {
    return db.prepare('SELECT id, business_name, website_url FROM sites WHERE id = ?')
      .all(parseInt(args.id, 10));
  }
  if (args.force) {
    return db.prepare('SELECT id, business_name, website_url FROM sites WHERE website_url IS NOT NULL ORDER BY id').all();
  }
  return db.prepare(
    'SELECT id, business_name, website_url FROM sites WHERE logo_url IS NULL AND website_url IS NOT NULL ORDER BY id'
  ).all();
}

/**
 * Score a logo candidate. Higher = better.
 * Uses URL heuristics + HEAD request for size/type.
 * No tesseract available in sandbox — OCR skipped.
 */
async function scoreLogo(url, businessName) {
  let score = 0;
  const lc = url.toLowerCase();

  // URL heuristics
  if (/\.svg(\?|$)/i.test(lc)) score += 2;           // SVG scales perfectly
  if (/logo/i.test(lc)) score += 2;                   // "logo" in URL
  if (/favicon/i.test(lc)) score -= 5;                // Favicon = bad
  if (/apple-touch-icon/i.test(lc)) score -= 1;       // Often square app icon
  if (/og[:-]image|hero|banner/i.test(lc)) score -= 2; // Banner, not logo

  // HEAD request to check size + content type
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; logobot/1.0)' },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (!res.ok) return -10;

    const size = parseInt(res.headers.get('content-length') || '0', 10);
    const type = (res.headers.get('content-type') || '').toLowerCase();

    if (size > 0 && size < 2000) score -= 3;           // Tiny file = favicon
    if (size > 5000) score += 1;                        // Decent size
    if (size > 20000) score += 1;                       // Large = full logo
    if (type.includes('svg')) score += 2;               // SVG confirmed
    if (type.includes('ico')) score -= 5;               // .ico = favicon
  } catch {
    // Can't HEAD — don't penalise heavily
  }

  return score;
}

async function scrapeLogo(websiteUrl, businessName) {
  const base = new URL(websiteUrl);
  const candidates = [];

  function add(url, source) {
    const resolved = resolveUrl(base, url);
    if (resolved && !candidates.some(c => c.url === resolved)) {
      candidates.push({ url: resolved, source });
    }
  }

  let html;
  try {
    const res = await fetch(websiteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; logobot/1.0)' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    html = await res.text();
  } catch {
    // Can't fetch site — try Brandfetch directly
    const bf = await brandfetch(base.hostname);
    return bf ?? `${base.origin}/favicon.ico`;
  }

  // 1. JSON-LD Organization logo
  const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const orgs = [data, ...(data['@graph'] || [])].filter(n => n?.['@type'] === 'Organization');
      for (const org of orgs) {
        const logo = org.logo;
        if (typeof logo === 'string') add(logo, 'json-ld');
        else if (logo?.url) add(logo.url, 'json-ld');
      }
    } catch { /* malformed JSON-LD — skip */ }
  }

  // 2. <img> where class, id, aria-label, or alt contains "logo"
  const imgLogoAttr = html.match(
    /<img[^>]+(?:class|id|aria-label|alt)=["'][^"']*logo[^"']*["'][^>]*>/gi
  );
  if (imgLogoAttr) {
    for (const tag of imgLogoAttr) {
      const src = tag.match(/src=["']([^"']+)["']/i)?.[1];
      if (src) add(src, 'img-attr');
    }
  }

  // 3. <a> with class/id "logo" wrapping an <img>
  const anchorLogo = html.match(/<a[^>]+(?:class|id)=["'][^"']*logo[^"']*["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)?.[1];
  if (anchorLogo) add(anchorLogo, 'anchor-logo');

  // 4. <img> with "logo" in src filename
  const logoSrc = html.match(/src=["']([^"']*logo[^"']*)["']/i)?.[1];
  if (logoSrc) add(logoSrc, 'src-filename');

  // 5. <link rel="apple-touch-icon">
  const touchIcon = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i)?.[1]
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon["']/i)?.[1];
  if (touchIcon) add(touchIcon, 'touch-icon');

  // 6. og:image
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  if (ogImage) add(ogImage, 'og-image');

  // If we have candidates, score and pick the best
  if (candidates.length > 0) {
    const scored = await Promise.all(
      candidates.map(async c => ({
        ...c,
        score: await scoreLogo(c.url, businessName),
      }))
    );
    scored.sort((a, b) => b.score - a.score);
    // Only use the winner if it's not actively bad
    if (scored[0].score >= -2) {
      return scored[0].url;
    }
  }

  // 7. Brandfetch API — only when on-site signals all scored poorly
  const bf = await brandfetch(base.hostname);
  if (bf) return bf;

  // 8. Favicon last resort
  return `${base.origin}/favicon.ico`;
}

async function brandfetch(domain) {
  const key = process.env.BRANDFETCH_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Prefer PNG/SVG logo over icon
    for (const type of ['logo', 'icon']) {
      const item = data.logos?.find(l => l.type === type);
      const format = item?.formats?.find(f => ['png', 'svg'].includes(f.format));
      if (format?.src) return format.src;
    }
  } catch { /* network or parse error */ }
  return null;
}

function resolveUrl(base, url) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

async function main() {
  const sites = getSites();

  if (sites.length === 0) {
    console.log('No sites need logo scraping.');
    return;
  }

  console.log(`Scraping logos for ${sites.length} sites${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  const update = db.prepare('UPDATE sites SET logo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

  let found = 0;
  let failed = 0;

  for (const site of sites) {
    const name = site.business_name.split('|')[0].trim();
    process.stdout.write(`[${site.id}] ${name}... `);

    const logo = await scrapeLogo(site.website_url, site.business_name);

    if (logo) {
      console.log(logo);
      if (!args['dry-run']) update.run(logo, site.id);
      found++;
    } else {
      console.log('not found');
      failed++;
    }
  }

  console.log(`\nDone: ${found} found, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
