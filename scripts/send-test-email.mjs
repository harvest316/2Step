#!/usr/bin/env node

/**
 * Send a test 2Step HTML email to deliverability test services.
 *
 * Usage:
 *   node scripts/send-test-email.mjs                    # Send to default test addresses
 *   node scripts/send-test-email.mjs user@example.com   # Send to specific address
 */

import '../src/utils/load-env.js';
import { Resend } from 'resend';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildEmailHtml } from '../src/outreach/email-template.js';
import { spin } from '../../333Method/src/utils/spintax.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_TEST_API_KEY || process.env.RESEND_API_KEY;
const BRAND_DOMAIN = process.env.BRAND_DOMAIN;
const BRAND_URL = (process.env.BRAND_URL || '').replace(/\/$/, '');
const SENDER_EMAIL = process.env.TWOSTEP_SENDER_EMAIL;
const SENDER_NAME = process.env.TWOSTEP_SENDER_NAME;
const LOGO_URL = process.env.TWOSTEP_LOGO_URL;
const UNSUBSCRIBE_URL = process.env.UNSUBSCRIBE_WORKER_URL;
const PHYSICAL_ADDRESS = process.env.CAN_SPAM_PHYSICAL_ADDRESS || '';

// ── Sample data ─────────────────────────────────────────────────────────────

const SAMPLE = {
  business_name: 'ACME Pest Control',
  city: 'Sydney',
  niche: 'pest control',
  review_author: 'Sarah Mitchell',
  star_rating: '4.9',
  review_count: '492',
  video_url: `${BRAND_URL}/demo/pest-control`,
  // TODO: replace with R2-hosted demo poster once demo videos are rendered
  thumbnail_url: 'https://placehold.co/400x711/1a1a2e/ffffff?text=ACME+Pest+Control%0A4.9+stars+%C2%B7+492+reviews%0A%E2%96%B6',
};

const SUBJECT = 'We created a free video from your top Google review — ACME Pest Control';

// Simulate a spun body with [poster] placeholder (Touch 1 style)
const BODY = `Hi there,

I was looking up pest control businesses in Sydney and noticed ACME Pest Control has some fantastic reviews on Google.

One in particular from Sarah Mitchell really resonated — so we turned it into a free 30-second video you can use for your website or socials.

[poster]

ACME Pest Control — 4.9 stars across 492 reviews. That's seriously impressive for a pest control business in Sydney. We chose Sarah Mitchell's standout review and turned it into the video above — completely free, no strings attached. Businesses using video reviews see up to 2x more enquiries than those without. Want anything changed?

Just hit reply if you'd like any changes — or if you want to chat about getting more of these made.

Cheers,
The ${process.env.BRAND_NAME || ''} Team`;

// ── Build email ─────────────────────────────────────────────────────────────

// Load fine_print from AU sequence template
let finePrint = '';
try {
  const seq = JSON.parse(readFileSync(resolve(ROOT, 'data/templates/AU/sequence.json'), 'utf-8'));
  if (seq.fine_print_spintax) {
    finePrint = spin(seq.fine_print_spintax
      .replace(/\[business_name\]/g, SAMPLE.business_name)
      .replace(/\[city\]/g, SAMPLE.city)
      .replace(/\[niche\]/g, SAMPLE.niche));
  }
} catch { /* non-fatal */ }

// Split on [poster]
const posterIdx = BODY.indexOf('[poster]');
const hookText = BODY.slice(0, posterIdx).replace(/\n+$/, '');
const remainingText = BODY.slice(posterIdx + '[poster]'.length).replace(/^\n+/, '');

function textToHtml(text) {
  if (!text) return '';
  return text.split(/\n+/).filter(l => l.trim()).map(l => `<p class="last-child">${l}</p>`).join('\n');
}

const unsubscribeUrl = `${UNSUBSCRIBE_URL}?email=test@example.com`;

const html = buildEmailHtml({
  previewText: SUBJECT,
  hookHtml: textToHtml(hookText),
  posterUrl: SAMPLE.thumbnail_url,
  videoUrl: SAMPLE.video_url,
  remainingBodyHtml: textToHtml(remainingText),
  ctaHtml: '',
  businessName: SAMPLE.business_name,
  logoUrl: LOGO_URL,
  unsubscribeUrl,
  physicalAddressHtml: PHYSICAL_ADDRESS || '',
  finePrintHtml: finePrint || '',
  year: String(new Date().getFullYear()),
  subject: SUBJECT,
  brandName: process.env.BRAND_NAME || '',
});

// Plain text: hook + video link only (no blurb, no fine_print)
const plainText = [
  SUBJECT, '', hookText, '',
  `Watch your video: ${SAMPLE.video_url}`, '',
  '---',
  'You received this because we thought ACME Pest Control deserved to see their great reviews turned into video.',
  `Unsubscribe: ${unsubscribeUrl}`,
].join('\n');

// ── Send ─────────────────────────────────────────────────────────────────────

const targets = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['test-vk2xyxbp1@srv1.mail-tester.com', 'mailteser+default@precheck.emailonacid.com'];

const resend = new Resend(RESEND_API_KEY);

for (const to of targets) {
  process.stdout.write(`Sending to ${to}... `);
  try {
    const { data, error } = await resend.emails.send({
      from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      to,
      subject: SUBJECT,
      html,
      text: plainText,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tracking: { open: true },
    });
    if (error) throw new Error(error.message);
    console.log(`\u2713  Resend ID: ${data.id}`);
  } catch (err) {
    console.error(`\u2717  ${err.message}`);
  }
}
