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

async function scrapeLogo(websiteUrl) {
  const base = new URL(websiteUrl);

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
    return brandfetch(base.hostname) ?? `${base.origin}/favicon.ico`;
  }

  // 1. JSON-LD Organization logo
  const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const orgs = [data, ...(data['@graph'] || [])].filter(n => n?.['@type'] === 'Organization');
      for (const org of orgs) {
        const logo = org.logo;
        if (typeof logo === 'string') return resolveUrl(base, logo);
        if (logo?.url) return resolveUrl(base, logo.url);
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
      if (src) return resolveUrl(base, src);
    }
  }

  // 3. <a> with class/id "logo" wrapping an <img>
  const anchorLogo = html.match(/<a[^>]+(?:class|id)=["'][^"']*logo[^"']*["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)?.[1];
  if (anchorLogo) return resolveUrl(base, anchorLogo);

  // 4. <img> with "logo" in src filename
  const logoSrc = html.match(/src=["']([^"']*logo[^"']*)["']/i)?.[1];
  if (logoSrc) return resolveUrl(base, logoSrc);

  // 5. <link rel="apple-touch-icon"> — higher-res than favicon
  const touchIcon = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i)?.[1]
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon["']/i)?.[1];
  if (touchIcon) return resolveUrl(base, touchIcon);

  // 6. og:image — their own image, often a banner but better than a third-party call
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  if (ogImage) return resolveUrl(base, ogImage);

  // 7. Brandfetch API — only when all on-site signals failed (conserve 100/mo quota)
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

    const logo = await scrapeLogo(site.website_url);

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
