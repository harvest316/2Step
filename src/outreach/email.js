#!/usr/bin/env node

/**
 * Email outreach for 2Step — sends video demo emails via Resend.
 *
 * Uses Mailchimp-derived HTML template (email-template.js) with poster image
 * (baked-in play button from creatomate.js) and spintax for subject/preheader/CTA.
 *
 * Layout: Logo → Hook text → Poster image → Remaining body + CTA → Divider → Footer
 *
 * Usage:
 *   node src/outreach/email.js                  # Send all pending email outreaches
 *   node src/outreach/email.js --limit 5        # Send up to 5
 *   node src/outreach/email.js --id 3           # Send specific outreach
 *   node src/outreach/email.js --dry-run        # Preview without sending
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import { Resend } from 'resend';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { spin } from '../../../333Method/src/utils/spintax.js';
import { buildEmailHtml } from './email-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_EMAIL = process.env.TWOSTEP_SENDER_EMAIL || 'videos@auditandfix.com';
const SENDER_NAME = process.env.TWOSTEP_SENDER_NAME || 'Audit&Fix Video Reviews';
const UNSUBSCRIBE_URL = process.env.UNSUBSCRIBE_WORKER_URL || 'https://unsubscribe-worker.auditandfix.workers.dev';
const LOGO_URL = process.env.TWOSTEP_LOGO_URL || 'https://auditandfix.com/assets/img/logo-light.svg';
const PHYSICAL_ADDRESS = process.env.CAN_SPAM_PHYSICAL_ADDRESS || '';

// CAN-SPAM countries — same list as 333Method/src/outreach/email-compliance.js
const CAN_SPAM_COUNTRIES = new Set([
  'US', 'CA', 'AU', 'NZ', 'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
  'AT', 'SE', 'DK', 'NO', 'FI', 'PL', 'IE', 'PT', 'GR', 'CZ', 'RO', 'HU', 'CH',
]);

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '10' },
    id: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

if (!RESEND_API_KEY) {
  console.error('ERROR: RESEND_API_KEY not set. Check ../333Method/.env.secrets');
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// ─── Spintax Templates ──────────────────────────────────────────────────────

const templateFile = resolve(root, 'data/templates/email.json');
const { templates } = JSON.parse(readFileSync(templateFile, 'utf-8'));

function pickTemplate(seed) {
  const idx = seed % templates.length;
  return templates[idx];
}

function spinField(spintaxText, businessName) {
  return spin(spintaxText.replace(/\[business_name\]/g, businessName));
}

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function getPendingEmails() {
  if (args.id) {
    return db.prepare(`
      SELECT o.*, p.business_name, p.city, p.niche, p.country_code,
             v.video_url, v.thumbnail_url
      FROM outreaches o
      JOIN prospects p ON p.id = o.prospect_id
      LEFT JOIN videos v ON v.id = o.video_id
      WHERE o.id = ? AND o.channel = 'email'
    `).all(parseInt(args.id, 10));
  }

  return db.prepare(`
    SELECT o.*, p.business_name, p.city, p.niche, p.country_code,
           v.video_url, v.thumbnail_url
    FROM outreaches o
    JOIN prospects p ON p.id = o.prospect_id
    LEFT JOIN videos v ON v.id = o.video_id
    WHERE o.channel = 'email'
      AND o.delivery_status = 'pending'
    ORDER BY o.created_at ASC
    LIMIT ?
  `).all(parseInt(args.limit, 10));
}

// ─── Email Assembly ─────────────────────────────────────────────────────────

/**
 * Split message_body into hook (first paragraph) and remaining body.
 * Hook goes above the poster image, remaining body goes below.
 */
function splitBody(messageBody) {
  const parts = messageBody.split(/\n\n+/);
  const hook = parts[0] || '';
  const remaining = parts.slice(1).join('\n\n');
  return { hook, remaining };
}

function textToHtml(text) {
  if (!text) return '';
  return text.split(/\n+/)
    .filter(line => line.trim())
    .map(line => `<p class="last-child">${line}</p>`)
    .join('\n');
}

function buildPlainText(outreach, subject, cta) {
  return [
    subject,
    '',
    outreach.message_body,
    '',
    `Watch your video: ${outreach.video_url}`,
    '',
    cta,
    '',
    '---',
    `You received this because we thought ${outreach.business_name} deserved to see their great reviews turned into video.`,
    `Unsubscribe: ${UNSUBSCRIBE_URL}?email=${encodeURIComponent(outreach.contact_uri)}`,
  ].join('\n');
}

function assembleEmail(outreach) {
  if (!outreach.thumbnail_url) {
    throw new Error('No poster image — run creatomate.js first');
  }
  if (!outreach.video_url) {
    throw new Error('No video URL — run creatomate.js first');
  }

  const template = pickTemplate(outreach.id);
  const businessName = outreach.business_name;

  const subject = spinField(template.subject_spintax, businessName);
  const previewText = spinField(template.preheader_spintax, businessName);
  const cta = spinField(template.cta_spintax, businessName);

  const { hook, remaining } = splitBody(outreach.message_body);
  const unsubscribeUrl = `${UNSUBSCRIBE_URL}?email=${encodeURIComponent(outreach.contact_uri)}`;

  // Physical address only for CAN-SPAM countries
  const countryCode = outreach.country_code || 'AU';
  const physicalAddressHtml = (PHYSICAL_ADDRESS && CAN_SPAM_COUNTRIES.has(countryCode))
    ? `<br /><br /><span style="font-size: 12px">${PHYSICAL_ADDRESS}</span>`
    : '';

  const html = buildEmailHtml({
    previewText,
    hookHtml: textToHtml(hook),
    posterUrl: outreach.thumbnail_url,
    videoUrl: outreach.video_url,
    remainingBodyHtml: textToHtml(remaining),
    ctaHtml: `<p class="last-child" style="margin-top: 16px; font-style: italic; color: rgb(100, 100, 100);">${cta}</p>`,
    businessName,
    logoUrl: LOGO_URL,
    unsubscribeUrl,
    physicalAddressHtml,
    year: String(new Date().getFullYear()),
  });

  const text = buildPlainText(outreach, subject, cta);

  return { html, text, subject };
}

// ─── Send ────────────────────────────────────────────────────────────────────

async function sendOne(outreach) {
  const { html, text, subject } = assembleEmail(outreach);

  if (args['dry-run']) {
    console.log(`  To: ${outreach.contact_uri}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Poster: ${outreach.thumbnail_url}`);
    console.log(`  Video: ${outreach.video_url}`);
    console.log('  ---');
    return { success: true, dryRun: true };
  }

  const { data, error } = await resend.emails.send({
    from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
    to: outreach.contact_uri,
    subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${UNSUBSCRIBE_URL}?email=${encodeURIComponent(outreach.contact_uri)}>`,
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  // Update outreach status
  db.prepare(`
    UPDATE outreaches
    SET delivery_status = 'sent', sent_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(outreach.id);

  // Update prospect status
  db.prepare(`
    UPDATE prospects SET status = 'outreach_sent', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status != 'outreach_sent'
  `).run(outreach.prospect_id);

  return { success: true, resendId: data?.id };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const emails = getPendingEmails();

  if (emails.length === 0) {
    console.log('No pending email outreaches. Generate messages with dm-generator.js first.');
    return;
  }

  console.log(`Sending ${emails.length} emails${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  let sent = 0;
  let failed = 0;

  for (const outreach of emails) {
    try {
      console.log(`[${outreach.id}] ${outreach.business_name} → ${outreach.contact_uri}`);
      const result = await sendOne(outreach);
      if (result.success) {
        sent++;
        if (result.resendId) console.log(`  ✓ Sent (${result.resendId})`);
      }
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      db.prepare(`
        UPDATE outreaches SET delivery_status = 'failed' WHERE id = ?
      `).run(outreach.id);
      failed++;
    }
  }

  console.log(`\nDone: ${sent} sent, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
}).finally(() => {
  db.close();
});
