#!/usr/bin/env node
/**
 * Enrich sites with email addresses scraped from their websites.
 * Fetches homepage + /contact page, extracts email via regex.
 *
 * Usage:
 *   node scripts/enrich-emails.js              # All sites missing email
 *   node scripts/enrich-emails.js --id 5       # Specific site
 *   node scripts/enrich-emails.js --dry-run    # Preview only
 */

import '../src/utils/load-env.js';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const db = new Database(resolve(root, 'db/2step.db'));

const { values: args } = parseArgs({
  options: {
    id: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

const EMAIL_RE = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;

// Common junk emails to skip
const JUNK_EMAILS = new Set([
  'noreply@', 'no-reply@', 'donotreply@', 'mailer-daemon@',
  'postmaster@', 'webmaster@', 'hostmaster@', 'abuse@',
  'admin@wordpress', 'wix.com', 'squarespace.com', 'godaddy.com',
  'sentry.io', 'cloudflare.com', 'google.com', 'facebook.com',
  'example.com', 'test.com',
]);

function isJunkEmail(email) {
  const lower = email.toLowerCase();
  for (const junk of JUNK_EMAILS) {
    if (lower.includes(junk)) return true;
  }
  // Skip image filenames that look like emails
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.svg')) return true;
  return false;
}

function cleanUrl(raw) {
  try {
    const url = new URL(raw);
    // Strip UTM params
    url.search = '';
    return url.href;
  } catch {
    return raw;
  }
}

async function fetchPage(url, label) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AuditBot/1.0)' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const text = await res.text();
    return text;
  } catch {
    return '';
  }
}

function extractEmails(html) {
  const matches = html.match(EMAIL_RE) || [];
  return [...new Set(matches)]
    .filter(e => !isJunkEmail(e))
    .map(e => e.toLowerCase());
}

async function enrichSite(site) {
  const baseUrl = cleanUrl(site.website_url);
  console.log(`[${site.id}] ${site.business_name}`);
  console.log(`  URL: ${baseUrl}`);

  // Fetch homepage
  process.stdout.write('  Fetching homepage...');
  const homepage = await fetchPage(baseUrl, 'homepage');
  process.stdout.write(` ${homepage.length} chars\n`);

  let emails = extractEmails(homepage);

  // Also try /contact, /contact-us, /about
  if (!emails.length) {
    for (const path of ['/contact', '/contact-us', '/about', '/about-us']) {
      const contactUrl = new URL(path, baseUrl).href;
      process.stdout.write(`  Trying ${path}...`);
      const html = await fetchPage(contactUrl, path);
      if (html) {
        const found = extractEmails(html);
        if (found.length) {
          emails = found;
          process.stdout.write(` found ${found.length}\n`);
          break;
        }
      }
      process.stdout.write(' none\n');
    }
  }

  if (!emails.length) {
    console.log('  ✗ No email found\n');
    return null;
  }

  // Prefer info@, contact@, hello@, enquiries@ over personal emails
  const preferred = ['info@', 'contact@', 'hello@', 'enquiries@', 'enquiry@', 'office@', 'admin@', 'mail@', 'bookings@', 'book@'];
  emails.sort((a, b) => {
    const aScore = preferred.findIndex(p => a.startsWith(p));
    const bScore = preferred.findIndex(p => b.startsWith(p));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  });

  const best = emails[0];
  console.log(`  ✓ Email: ${best}${emails.length > 1 ? ` (+ ${emails.length - 1} others: ${emails.slice(1).join(', ')})` : ''}\n`);
  return best;
}

async function main() {
  const query = args.id
    ? db.prepare('SELECT id, business_name, website_url FROM sites WHERE id = ? AND email IS NULL AND website_url IS NOT NULL').all(parseInt(args.id))
    : db.prepare('SELECT id, business_name, website_url FROM sites WHERE email IS NULL AND website_url IS NOT NULL ORDER BY id').all();

  console.log(`Enriching ${query.length} sites for email...\n`);

  let found = 0;
  for (const site of query) {
    const email = await enrichSite(site);
    if (email && !args['dry-run']) {
      db.prepare('UPDATE sites SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(email, site.id);
      found++;
    } else if (email) {
      found++;
    }
  }

  db.close();
  console.log(`Done: ${found}/${query.length} emails found${args['dry-run'] ? ' (dry run)' : ''}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
