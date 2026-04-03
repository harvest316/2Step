#!/usr/bin/env node

/**
 * Outreach pipeline stage for 2Step.
 *
 * Sends approved messages from msgs.messages where project='2step' via
 * email (Resend) or SMS (Twilio). Checks opt-outs before sending.
 *
 * Sequence-aware: respects scheduled_send_at cadence and stops sending
 * further touches once a reply has been received for a site.
 *
 * Usage:
 *   node src/stages/outreach.js              # Send all approved email+SMS
 *   node src/stages/outreach.js --limit 5    # Send up to 5
 *   node src/stages/outreach.js --dry-run    # Preview without sending
 *   node src/stages/outreach.js --method sms # SMS only
 */

import '../utils/load-env.js';
import { Resend } from 'resend';
import twilio from 'twilio';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { getOne, getAll, run } from '../utils/db.js';
import { buildEmailHtml } from '../outreach/email-template.js';
import { spin } from '../../../333Method/src/utils/spintax.js';
import { parseEnvSet } from '../../../333Method/src/utils/load-env.js';
import { checkBeforeSend } from '../../../mmo-platform/src/suppression.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_NAME = process.env.TWOSTEP_SENDER_NAME;

// Sending subdomains — rotated by site_id to spread domain reputation risk.
// Add new subdomains here as they're verified in Resend.
// test.{BRAND_DOMAIN} is excluded — reserved for test sends only.
const SENDER_SUBDOMAINS = (process.env.TWOSTEP_SENDER_SUBDOMAINS || 'send,mail,email,outreach,outbound,eu,sa')
  .split(',').map(s => s.trim()).filter(Boolean);
const SENDER_LOCAL = process.env.TWOSTEP_SENDER_LOCAL || 'videos';

function getSenderForSite(siteId) {
  const subdomain = SENDER_SUBDOMAINS[siteId % SENDER_SUBDOMAINS.length];
  const brandDomain = process.env.BRAND_DOMAIN;
  return `${SENDER_LOCAL}@${subdomain}.${brandDomain}`;
}
const UNSUBSCRIBE_URL = process.env.UNSUBSCRIBE_WORKER_URL;
const BRAND_URL = (process.env.BRAND_URL || '').replace(/\/$/, '');
const LOGO_URL = process.env.TWOSTEP_LOGO_URL;
const PHYSICAL_ADDRESS = process.env.CAN_SPAM_PHYSICAL_ADDRESS || '';

// CAN-SPAM countries — require physical address in footer
const CAN_SPAM_COUNTRIES = new Set([
  'US', 'CA', 'AU', 'NZ', 'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
  'AT', 'SE', 'DK', 'NO', 'FI', 'PL', 'IE', 'PT', 'GR', 'CZ', 'RO', 'HU', 'CH',
]);

// Countries blocked from SMS (legal compliance — DR-121).
// Only AU and NZ have a clean legal basis for cold SMS.
const OUTREACH_BLOCKED_SMS_COUNTRIES = parseEnvSet(process.env.OUTREACH_BLOCKED_SMS_COUNTRIES);

// ── Sequence template loader (cached) ────────────────────────────────────────

const sequenceCache = new Map();

function loadSequenceTemplate(countryCode) {
  if (sequenceCache.has(countryCode)) return sequenceCache.get(countryCode);
  const filePath = resolve(ROOT, `data/templates/${countryCode}/sequence.json`);
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  sequenceCache.set(countryCode, data);
  return data;
}

// ── Opt-out check ────────────────────────────────────────────────────────────

/**
 * Check whether a contact URI (email or phone) is opted out for a given method.
 * Queries msgs.opt_outs in the shared messages schema.
 *
 * @param {string|null} phone
 * @param {string|null} email
 * @param {'sms'|'email'} method
 * @returns {Promise<boolean>}
 */
async function isOptedOut(phone, email, method) {
  if (!phone && !email) return false;
  try {
    const row = await getOne(
      `SELECT 1 FROM msgs.opt_outs
       WHERE method = $1
       AND (phone = $2 OR email = $3)
       LIMIT 1`,
      [method, phone ?? null, email ?? null]
    );
    return Boolean(row);
  } catch (_) {
    // msgs.opt_outs not available — don't block
    return false;
  }
}

// ── Email helpers ────────────────────────────────────────────────────────────

/**
 * Split message_body on [poster] placeholder.
 * Hook (above poster image) = everything before [poster].
 * Remaining (below poster) = everything after [poster].
 * Falls back to first-paragraph split if no [poster] tag found.
 */
function splitBody(messageBody) {
  const body = messageBody || '';
  const posterIdx = body.indexOf('[poster]');
  if (posterIdx !== -1) {
    const hook = body.slice(0, posterIdx).replace(/\n+$/, '');
    const remaining = body.slice(posterIdx + '[poster]'.length).replace(/^\n+/, '');
    return { hook, remaining };
  }
  // Legacy fallback: split on first double-newline
  const parts = body.split(/\n\n+/);
  const hook = parts[0] || '';
  const remaining = parts.slice(1).join('\n\n');
  return { hook, remaining };
}

function textToHtml(text) {
  if (!text) return '';
  return text
    .split(/\n+/)
    .filter(line => line.trim())
    .map(line => `<p class="last-child">${line}</p>`)
    .join('\n');
}

function buildPlainText(msg, videoUrl, subject) {
  // Plain text: hook only (above poster), skip blurb (no image = no spam rule)
  // No fine_print in plain text — it's HTML padding only
  const body = msg.message_body || '';
  const posterIdx = body.indexOf('[poster]');
  const hookText = posterIdx !== -1 ? body.slice(0, posterIdx).replace(/\n+$/, '') : body;
  return [
    subject,
    '',
    hookText,
    '',
    `Watch your video: ${videoUrl}`,
    '',
    '---',
    `You received this because we thought ${msg.business_name} deserved to see their great reviews turned into video.`,
    `Unsubscribe: ${UNSUBSCRIBE_URL}?email=${encodeURIComponent(msg.contact_uri)}`,
  ].join('\n');
}

/**
 * Assemble the HTML + text email for a given message row.
 *
 * @param {Object} msg - Row from the pending email query (includes site + video fields)
 * @returns {{ html: string, text: string, subject: string }}
 */
function assembleEmail(msg) {
  if (!msg.thumbnail_url) {
    throw new Error(`No thumbnail_url for message #${msg.id} — run video stage first`);
  }
  if (!msg.video_url) {
    throw new Error(`No video_url for message #${msg.id} — run video stage first`);
  }

  const businessName = msg.business_name || 'your business';
  const countryCode = msg.country_code || 'AU';

  // Use stored subject/preheader from proposal generation
  const subject = msg.subject_line || `Your free video review is ready, ${businessName}`;
  const previewText = subject; // preheader was spun at proposal time

  // Load country sequence template for fine_print
  let finePrint = '';
  try {
    const seqTemplate = loadSequenceTemplate(countryCode);
    if (seqTemplate.fine_print_spintax) {
      finePrint = spin(seqTemplate.fine_print_spintax
        .replace(/\[business_name\]/g, businessName)
        .replace(/\[city\]/g, msg.city || '')
        .replace(/\[niche\]/g, msg.niche || ''));
    }
  } catch {
    // Non-fatal: fine print is supplementary
  }

  // Split on [poster] — hook above image, remaining below
  const { hook, remaining } = splitBody(msg.message_body);
  const unsubscribeUrl = `${UNSUBSCRIBE_URL}?email=${encodeURIComponent(msg.contact_uri)}`;
  const physicalAddressHtml =
    PHYSICAL_ADDRESS && CAN_SPAM_COUNTRIES.has(countryCode)
      ? PHYSICAL_ADDRESS
      : '';

  // Use /p/{hash} as poster src — logs email open on image load, then redirects to CDN
  const posterTrackingUrl = msg.video_hash
    ? `${BRAND_URL}/p/${msg.video_hash}`
    : msg.thumbnail_url;

  const html = buildEmailHtml({
    previewText,
    hookHtml: textToHtml(hook),
    posterUrl: posterTrackingUrl,
    videoUrl: msg.video_url,
    remainingBodyHtml: textToHtml(remaining),
    ctaHtml: '', // CTA is now embedded in body_spintax, not separate
    businessName,
    logoUrl: LOGO_URL,
    unsubscribeUrl,
    physicalAddressHtml,
    finePrintHtml: finePrint || '',
    year: String(new Date().getFullYear()),
    subject,
    brandName: process.env.BRAND_NAME || '',
  });

  const text = buildPlainText(msg, msg.video_url, subject);

  return { html, text, subject };
}

// ── Email send ───────────────────────────────────────────────────────────────

/* c8 ignore start — Resend/Twilio API + DB writes I/O */
/**
 * Send a single email message.
 *
 * @param {Object} msg - Row from pending email query
 * @param {Resend} resend - Resend client instance
 * @param {boolean} dryRun
 * @param {Object} [testOpts] - { email, cc } — overrides recipient; skips DB update
 * @returns {Promise<{ success: boolean, resendId?: string, dryRun?: boolean }>}
 */
async function sendEmail(msg, resend, dryRun, testOpts) {
  const isTest = Boolean(testOpts?.email);
  const toAddress = isTest ? testOpts.email : msg.contact_uri;

  if (!isTest) {
    // Cross-project suppression check (shared with 333Method)
    try {
      const suppression = await checkBeforeSend({ email: msg.contact_uri });
      if (suppression.blocked) {
        console.log(`  [${msg.id}] Blocked by cross-project suppression: ${suppression.reason}`);
        return { success: false, skipped: true, reason: 'cross_project_suppressed' };
      }
    } catch (e) {
      console.warn(`  Suppression check failed (non-fatal): ${e.message}`);
    }

    if (await isOptedOut(null, msg.contact_uri, 'email')) {
      await run(
        `UPDATE msgs.messages
         SET delivery_status = 'skipped', error_message = 'opted out',
             updated_at = NOW()
         WHERE id = $1`,
        [msg.id]
      );
      console.log(`  [${msg.id}] Skipped (opted out): ${msg.contact_uri}`);
      return { success: false, skipped: true, reason: 'opted_out' };
    }
  }

  const { html, text, subject } = assembleEmail(msg);

  if (dryRun) {
    console.log(`  [${msg.id}] DRY RUN to: ${toAddress}${isTest ? ' [TEST]' : ''}`);
    console.log(`    Subject: ${subject}`);
    console.log(`    Poster:  ${msg.thumbnail_url}`);
    console.log(`    Video:   ${msg.video_url}`);
    return { success: true, dryRun: true };
  }

  const senderEmail = isTest
    ? (process.env.TWOSTEP_SENDER_EMAIL || getSenderForSite(0))
    : getSenderForSite(msg.site_id);

  const sendPayload = {
    from: `${SENDER_NAME} <${senderEmail}>`,
    to: toAddress,
    subject: isTest ? `[TEST] ${subject}` : subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${UNSUBSCRIBE_URL}?email=${encodeURIComponent(msg.contact_uri)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    // Click tracking disabled — Resend's resend-clicks-a.com domain triggers URIBL_INVALUEMENT
    // Open tracking also disabled to avoid third-party pixel domains in headers
  };

  if (isTest && testOpts.cc) {
    sendPayload.cc = testOpts.cc;
  }

  const { data, error } = await resend.emails.send(sendPayload);

  if (error) {
    throw new Error(error.message);
  }

  const emailId = data?.id || null;

  if (!isTest) {
    await run(
      `UPDATE msgs.messages
       SET delivery_status = 'sent',
           sent_at = NOW(),
           email_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [emailId, msg.id]
    );

    await run(
      `UPDATE sites SET last_outreach_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [msg.site_id]
    );
  } else {
    console.log(`  [TEST] Sent to ${toAddress} (real address ${msg.contact_uri} not updated)`);
  }

  return { success: true, resendId: emailId };
}

// ── SMS send ─────────────────────────────────────────────────────────────────

/**
 * Format a phone number to E.164 (best-effort; mirrors 333Method's formatPhoneNumber).
 */
function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('04')) {
    cleaned = `61${cleaned.slice(1)}`;
  } else if (cleaned.length === 10 && !cleaned.startsWith('61')) {
    cleaned = `1${cleaned}`;
  }
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

/**
 * Send a single SMS message.
 *
 * @param {Object} msg - Row from pending SMS query
 * @param {import('twilio').Twilio} twilioClient
 * @param {boolean} dryRun
 * @returns {Promise<{ success: boolean, sid?: string, dryRun?: boolean }>}
 */
async function sendSms(msg, twilioClient, dryRun) {
  const toNumber = formatPhoneNumber(msg.contact_uri);
  const country = (msg.country_code || '').toUpperCase();

  if (OUTREACH_BLOCKED_SMS_COUNTRIES.has(country)) {
    await run(
      `UPDATE msgs.messages
       SET delivery_status = 'skipped', error_message = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [`sms_blocked:${country}`, msg.id]
    );
    console.log(`  [${msg.id}] Blocked: SMS not permitted for ${country} (DR-121)`);
    return { success: false, skipped: true, reason: `sms_blocked:${country}` };
  }

  // Cross-project suppression check (shared with 333Method)
  try {
    const suppression = await checkBeforeSend({ phone: toNumber });
    if (suppression.blocked) {
      console.log(`  [${msg.id}] Blocked by cross-project suppression: ${suppression.reason}`);
      return { success: false, skipped: true, reason: 'cross_project_suppressed' };
    }
  } catch (e) {
    console.warn(`  Suppression check failed (non-fatal): ${e.message}`);
  }

  if (await isOptedOut(toNumber, null, 'sms')) {
    await run(
      `UPDATE msgs.messages
       SET delivery_status = 'skipped', error_message = 'opted out',
           updated_at = NOW()
       WHERE id = $1`,
      [msg.id]
    );
    console.log(`  [${msg.id}] Skipped (opted out): ${toNumber}`);
    return { success: false, skipped: true, reason: 'opted_out' };
  }

  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) {
    throw new Error('TWILIO_PHONE_NUMBER not set');
  }

  if (dryRun) {
    console.log(`  [${msg.id}] DRY RUN SMS to: ${toNumber}`);
    console.log(`    Body: ${(msg.message_body || '').slice(0, 80)}...`);
    return { success: true, dryRun: true };
  }

  const message = await twilioClient.messages.create({
    body: msg.message_body,
    from: fromNumber,
    to: toNumber,
  });

  await run(
    `UPDATE msgs.messages
     SET delivery_status = 'sent',
         sent_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [msg.id]
  );

  await run(
    `UPDATE sites SET last_outreach_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [msg.site_id]
  );

  return { success: true, sid: message.sid };
}

// ── Stage runner ─────────────────────────────────────────────────────────────

/**
 * Run the 2Step outreach stage — send all approved, unsent email and SMS messages.
 *
 * @param {Object} [options]
 * @param {number} [options.limit]            - Max messages to send per method
 * @param {boolean} [options.dryRun=false]    - Preview without sending
 * @param {string[]} [options.methods]        - Channels to send (['email','sms'])
 * @param {string} [options.testEmail]        - Override recipient (test mode — skips DB update)
 * @param {string} [options.testCc]           - CC address for test sends
 * @param {number} [options.messageId]        - Send a specific message by ID
 * @returns {Promise<{ sent: number, failed: number, skipped: number }>}
 */
export async function runOutreachStage(options = {}) {
  const { limit, dryRun = false, methods = ['email', 'sms'], testEmail, testCc, messageId } = options;

  console.log(
    `[outreach] Starting 2Step outreach stage` +
    ` (methods=${methods.join(',')}, limit=${limit ?? 'all'}${dryRun ? ', DRY RUN' : ''})`
  );

  const stats = { sent: 0, failed: 0, skipped: 0 };

  // ── Email ──────────────────────────────────────────────────────────────────

  if (methods.includes('email')) {
    if (!RESEND_API_KEY) {
      console.warn('[outreach] RESEND_API_KEY not set — skipping email');
    } else {
      const resend = new Resend(RESEND_API_KEY);

      const limitClause = limit ? `LIMIT ${parseInt(limit, 10)}` : '';
      const messageIdClause = messageId ? `AND m.id = ${parseInt(messageId, 10)}` : '';
      const emails = await getAll(
        `SELECT m.id, m.site_id, m.contact_uri, m.message_body, m.subject_line,
                m.sequence_step, m.scheduled_send_at,
                s.business_name, s.country_code, s.city, s.niche,
                s.best_review_author, s.google_rating, s.review_count, s.video_hash,
                COALESCE(m.video_url, v.video_url) AS video_url, v.thumbnail_url
         FROM msgs.messages m
         JOIN twostep.sites s ON s.id = m.site_id
         LEFT JOIN twostep.videos v ON v.id = s.video_id
         WHERE m.project = '2step'
           AND m.direction = 'outbound'
           AND m.contact_method = 'email'
           AND m.approval_status = 'approved'
           AND (m.delivery_status IS NULL OR m.delivery_status = 'queued')
           ${messageIdClause}
           -- Respect cadence: only send if schedule time has passed (or no schedule set)
           AND (m.scheduled_send_at IS NULL OR m.scheduled_send_at <= NOW())
           -- Stop sequence if prospect has replied (inbound message exists for this site)
           AND NOT EXISTS (
             SELECT 1 FROM msgs.messages reply
             WHERE reply.project = '2step'
               AND reply.site_id = m.site_id
               AND reply.direction = 'inbound'
               AND reply.contact_uri = m.contact_uri
           )
         ORDER BY m.sequence_step ASC, m.created_at ASC
         ${limitClause}`
      );

      console.log(`[outreach] ${emails.length} pending email message(s)`);

      for (const msg of emails) {
        try {
          const testLabel = testEmail ? ` [TEST -> ${testEmail}]` : '';
          console.log(`[outreach] Email [${msg.id}] ${msg.business_name} -> ${msg.contact_uri}${testLabel}`);
          const testOpts = testEmail ? { email: testEmail, cc: testCc } : undefined;
          const result = await sendEmail(msg, resend, dryRun, testOpts);
          if (result.skipped) {
            stats.skipped++;
          } else {
            stats.sent++;
            if (result.resendId) console.log(`  sent (${result.resendId})`);
            if (result.dryRun) console.log(`  (dry run)`);
          }
        } catch (err) {
          console.error(`  failed: ${err.message}`);
          await run(
            `UPDATE msgs.messages
             SET delivery_status = 'failed', error_message = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [err.message.slice(0, 500), msg.id]
          );
          stats.failed++;
        }

        // Brief pause between sends to avoid rate limits
        if (!dryRun) {
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
  }

  // ── SMS ───────────────────────────────────────────────────────────────────

  if (methods.includes('sms')) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.warn('[outreach] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — skipping SMS');
    } else {
      const twilioClient = twilio(accountSid, authToken);

      const smsLimitClause = limit ? `LIMIT ${parseInt(limit, 10)}` : '';
      // $1 = smsBlockedCountries — only param; update index if query gains earlier params
      const smsBlockedCountries = [...OUTREACH_BLOCKED_SMS_COUNTRIES];
      const smsBlockedClause = smsBlockedCountries.length > 0
        ? `AND s.country_code != ALL($1::text[])`
        : '';
      const smsList = await getAll(
        `SELECT m.id, m.site_id, m.contact_uri, m.message_body,
                m.sequence_step, m.scheduled_send_at,
                s.business_name, s.country_code
         FROM msgs.messages m
         JOIN sites s ON s.id = m.site_id
         WHERE m.project = '2step'
           AND m.direction = 'outbound'
           AND m.contact_method = 'sms'
           AND m.approval_status = 'approved'
           AND (m.delivery_status IS NULL OR m.delivery_status = 'queued')
           -- Respect cadence: only send if schedule time has passed (or no schedule set)
           AND (m.scheduled_send_at IS NULL OR m.scheduled_send_at <= NOW())
           -- Block SMS for countries without legal basis (DR-121)
           ${smsBlockedClause}
           -- Stop sequence if prospect has replied (inbound message exists for this site)
           AND NOT EXISTS (
             SELECT 1 FROM msgs.messages reply
             WHERE reply.project = '2step'
               AND reply.site_id = m.site_id
               AND reply.direction = 'inbound'
           )
         ORDER BY m.sequence_step ASC, m.created_at ASC
         ${smsLimitClause}`,
        smsBlockedCountries.length ? [smsBlockedCountries] : []
      );

      console.log(`[outreach] ${smsList.length} pending SMS message(s)`);

      for (const msg of smsList) {
        try {
          console.log(`[outreach] SMS [${msg.id}] ${msg.business_name} -> ${msg.contact_uri}`);
          const result = await sendSms(msg, twilioClient, dryRun);
          if (result.skipped) {
            stats.skipped++;
          } else {
            stats.sent++;
            if (result.sid) console.log(`  sent (${result.sid})`);
            if (result.dryRun) console.log(`  (dry run)`);
          }
        } catch (err) {
          console.error(`  failed: ${err.message}`);
          await run(
            `UPDATE msgs.messages
             SET delivery_status = 'failed', error_message = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [err.message.slice(0, 500), msg.id]
          );
          stats.failed++;
        }

        // 1s between SMS to avoid carrier throttling
        if (!dryRun) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  }

  console.log(
    `[outreach] Stage complete: ${stats.sent} sent, ${stats.failed} failed, ${stats.skipped} skipped`
  );

  return stats;
}

/* c8 ignore stop */

// ── Test-visible exports for pure helper functions ───────────────────────────

export { splitBody, textToHtml, buildPlainText, CAN_SPAM_COUNTRIES, formatPhoneNumber, assembleEmail, loadSequenceTemplate, isOptedOut };

// ── CLI entry point ──────────────────────────────────────────────────────────

/* c8 ignore start — CLI entry point */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values: args } = parseArgs({
    options: {
      limit:        { type: 'string' },
      'dry-run':    { type: 'boolean', default: false },
      method:       { type: 'string' },
      'test-email': { type: 'string' },
      'test-cc':    { type: 'string' },
      'message-id': { type: 'string' },
    },
    strict: false,
  });

  const methods = args.method
    ? [args.method]
    : (args['test-email'] ? ['email'] : ['email', 'sms']); // test mode is email-only

  runOutreachStage({
    limit:     args.limit ? parseInt(args.limit, 10) : undefined,
    dryRun:    args['dry-run'],
    methods,
    testEmail: args['test-email'],
    testCc:    args['test-cc'],
    messageId: args['message-id'] ? parseInt(args['message-id'], 10) : undefined,
  })
    .then(stats => {
      console.log('\nDone:', stats);
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
/* c8 ignore stop */
