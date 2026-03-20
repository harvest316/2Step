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
const SENDER_EMAIL = process.env.TWOSTEP_SENDER_EMAIL || 'videos@auditandfix.com';
const SENDER_NAME = process.env.TWOSTEP_SENDER_NAME || 'Audit&Fix Video Reviews';
const LOGO_URL = process.env.TWOSTEP_LOGO_URL || 'https://auditandfix.com/assets/img/logo-light.svg';
const UNSUBSCRIBE_URL = process.env.UNSUBSCRIBE_WORKER_URL || 'https://unsubscribe-worker.auditandfix.workers.dev';
const PHYSICAL_ADDRESS = process.env.CAN_SPAM_PHYSICAL_ADDRESS || '';

// ── Sample data ─────────────────────────────────────────────────────────────

const SAMPLE = {
  business_name: 'Pest Control Sydney Wide',
  city: 'Sydney',
  niche: 'pest control',
  review_author: 'Adrienne Vili',
  star_rating: '4.9',
  review_count: '492',
  video_url: 'https://auditandfix.com/v/demo-pest-control',
  // Use a real poster-sized placeholder image
  thumbnail_url: 'https://placehold.co/561x315/1a1a2e/ffffff?text=Pest+Control+Sydney+Wide%0A%E2%98%85+4.9+stars+%C2%B7+492+reviews%0A%E2%96%B6+Watch+Video',
};

const SUBJECT = 'We created a free video from your top Google review — Pest Control Sydney Wide';

// Simulate a spun body with [poster] placeholder (Touch 1 style)
const BODY = `Hi there,

I was looking up pest control businesses in Sydney and noticed Pest Control Sydney Wide has some fantastic reviews on Google.

One in particular from Adrienne Vili really resonated — so we turned it into a free 30-second video you can use for your website or socials.

[poster]

Pest Control Sydney Wide — 4.9 stars across 492 reviews. That's seriously impressive for a pest control business in Sydney. We chose Adrienne Vili's standout review and turned it into the video above — completely free, no strings attached. Businesses using video reviews see up to 2x more enquiries than those without. Want anything changed?

Just hit reply if you'd like any changes — or if you want to chat about getting more of these made.

Cheers,
The Audit&Fix Team`;

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
  physicalAddressHtml: PHYSICAL_ADDRESS
    ? `<br /><br /><span style="font-size: 12px">${PHYSICAL_ADDRESS}</span>`
    : '',
  finePrintHtml: finePrint ? `<br /><span style="font-size: 12px">${finePrint}</span>` : '',
  year: String(new Date().getFullYear()),
  subject: SUBJECT,
});

// Plain text: hook + video link only (no blurb)
const plainText = [
  SUBJECT, '', hookText, '',
  `Watch your video: ${SAMPLE.video_url}`, '',
  '---',
  finePrint || 'You received this because we thought Pest Control Sydney Wide deserved to see their great reviews turned into video.',
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
