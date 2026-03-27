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
import db from '../utils/db.js';
import { buildEmailHtml } from '../outreach/email-template.js';
import { spin } from '../../../333Method/src/utils/spintax.js';
import { openDb as openSuppressionDb, checkBeforeSend } from '../../../mmo-platform/src/suppression.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_EMAIL = process.env.TWOSTEP_SENDER_EMAIL || 'videos@auditandfix.com';
const SENDER_NAME = process.env.TWOSTEP_SENDER_NAME || 'Audit&Fix Video Reviews';
const UNSUBSCRIBE_URL =
  process.env.UNSUBSCRIBE_WORKER_URL || 'https://unsubscribe-worker.auditandfix.workers.dev';
const LOGO_URL = process.env.TWOSTEP_LOGO_URL || 'https://auditandfix.com/assets/img/logo-light.svg';
const PHYSICAL_ADDRESS = process.env.CAN_SPAM_PHYSICAL_ADDRESS || '';

// CAN-SPAM countries — require physical address in footer
const CAN_SPAM_COUNTRIES = new Set([
  'US', 'CA', 'AU', 'NZ', 'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
  'AT', 'SE', 'DK', 'NO', 'FI', 'PL', 'IE', 'PT', 'GR', 'CZ', 'RO', 'HU', 'CH',
]);

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
 * Queries msgs.opt_outs in the shared messages DB (ATTACHed as `msgs`).
 *
 * @param {string|null} phone
 * @param {string|null} email
 * @param {'sms'|'email'} method
 * @returns {boolean}
 */
function isOptedOut(phone, email, method) {
  if (!phone && !email) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM msgs.opt_outs
         WHERE method = ?
         AND (phone = ? OR email = ?)
         LIMIT 1`
      )
      .get(method, phone ?? null, email ?? null);
    return Boolean(row);
  } catch (_) {
    // msgs.opt_outs not available (e.g. messages.db not ATTACHed) — don't block
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

  const html = buildEmailHtml({
    previewText,
    hookHtml: textToHtml(hook),
    posterUrl: msg.thumbnail_url,
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
 * @returns {Promise<{ success: boolean, resendId?: string, dryRun?: boolean }>}
 */
async function sendEmail(msg, resend, dryRun) {
  // Cross-project suppression check (shared with 333Method)
  try {
    const sDb = openSuppressionDb();
    const suppression = checkBeforeSend({ email: msg.contact_uri }, sDb);
    sDb.close();
    if (suppression.blocked) {
      console.log(`  [${msg.id}] Blocked by cross-project suppression: ${suppression.reason}`);
      return { success: false, skipped: true, reason: 'cross_project_suppressed' };
    }
  } catch (e) {
    console.warn(`  Suppression check failed (non-fatal): ${e.message}`);
  }

  if (isOptedOut(null, msg.contact_uri, 'email')) {
    db.prepare(
      `UPDATE msgs.messages
       SET delivery_status = 'failed', error_message = 'opted out',
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(msg.id);
    console.log(`  [${msg.id}] Skipped (opted out): ${msg.contact_uri}`);
    return { success: false, skipped: true, reason: 'opted_out' };
  }

  const { html, text, subject } = assembleEmail(msg);

  if (dryRun) {
    console.log(`  [${msg.id}] DRY RUN to: ${msg.contact_uri}`);
    console.log(`    Subject: ${subject}`);
    console.log(`    Poster:  ${msg.thumbnail_url}`);
    console.log(`    Video:   ${msg.video_url}`);
    return { success: true, dryRun: true };
  }

  const { data, error } = await resend.emails.send({
    from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
    to: msg.contact_uri,
    subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${UNSUBSCRIBE_URL}?email=${encodeURIComponent(msg.contact_uri)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tracking: { open: true }, // 2Step emails already have images — pixel adds zero spam cost
  });

  if (error) {
    throw new Error(error.message);
  }

  const emailId = data?.id || null;

  db.prepare(
    `UPDATE msgs.messages
     SET delivery_status = 'sent',
         sent_at = datetime('now'),
         email_id = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(emailId, msg.id);

  db.prepare(
    `UPDATE sites SET last_outreach_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(msg.site_id);

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

  // Cross-project suppression check (shared with 333Method)
  try {
    const sDb = openSuppressionDb();
    const suppression = checkBeforeSend({ phone: toNumber }, sDb);
    sDb.close();
    if (suppression.blocked) {
      console.log(`  [${msg.id}] Blocked by cross-project suppression: ${suppression.reason}`);
      return { success: false, skipped: true, reason: 'cross_project_suppressed' };
    }
  } catch (e) {
    console.warn(`  Suppression check failed (non-fatal): ${e.message}`);
  }

  if (isOptedOut(toNumber, null, 'sms')) {
    db.prepare(
      `UPDATE msgs.messages
       SET delivery_status = 'failed', error_message = 'opted out',
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(msg.id);
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

  db.prepare(
    `UPDATE msgs.messages
     SET delivery_status = 'sent',
         sent_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(msg.id);

  db.prepare(
    `UPDATE sites SET last_outreach_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(msg.site_id);

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
 * @returns {Promise<{ sent: number, failed: number, skipped: number }>}
 */
export async function runOutreachStage(options = {}) {
  const { limit, dryRun = false, methods = ['email', 'sms'] } = options;

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
      const emails = db
        .prepare(
          `SELECT m.id, m.site_id, m.contact_uri, m.message_body, m.subject_line,
                  m.sequence_step, m.scheduled_send_at,
                  s.business_name, s.country_code, s.city, s.niche,
                  s.best_review_author, s.google_rating, s.review_count,
                  COALESCE(m.video_url, v.video_url) AS video_url, v.thumbnail_url
           FROM msgs.messages m
           JOIN sites s ON s.id = m.site_id
           LEFT JOIN videos v ON v.id = s.video_id
           WHERE m.project = '2step'
             AND m.direction = 'outbound'
             AND m.contact_method = 'email'
             AND m.approval_status = 'approved'
             AND (m.delivery_status IS NULL OR m.delivery_status = 'queued')
             -- Respect cadence: only send if schedule time has passed (or no schedule set)
             AND (m.scheduled_send_at IS NULL OR m.scheduled_send_at <= datetime('now'))
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
        )
        .all();

      console.log(`[outreach] ${emails.length} pending email message(s)`);

      for (const msg of emails) {
        try {
          console.log(`[outreach] Email [${msg.id}] ${msg.business_name} → ${msg.contact_uri}`);
          const result = await sendEmail(msg, resend, dryRun);
          if (result.skipped) {
            stats.skipped++;
          } else {
            stats.sent++;
            if (result.resendId) console.log(`  sent (${result.resendId})`);
            if (result.dryRun) console.log(`  (dry run)`);
          }
        } catch (err) {
          console.error(`  failed: ${err.message}`);
          db.prepare(
            `UPDATE msgs.messages
             SET delivery_status = 'failed', error_message = ?,
                 updated_at = datetime('now')
             WHERE id = ?`
          ).run(err.message.slice(0, 500), msg.id);
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
      const smsList = db
        .prepare(
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
             AND (m.scheduled_send_at IS NULL OR m.scheduled_send_at <= datetime('now'))
             -- Stop sequence if prospect has replied (inbound message exists for this site)
             AND NOT EXISTS (
               SELECT 1 FROM msgs.messages reply
               WHERE reply.project = '2step'
                 AND reply.site_id = m.site_id
                 AND reply.direction = 'inbound'
             )
           ORDER BY m.sequence_step ASC, m.created_at ASC
           ${smsLimitClause}`
        )
        .all();

      console.log(`[outreach] ${smsList.length} pending SMS message(s)`);

      for (const msg of smsList) {
        try {
          console.log(`[outreach] SMS [${msg.id}] ${msg.business_name} → ${msg.contact_uri}`);
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
          db.prepare(
            `UPDATE msgs.messages
             SET delivery_status = 'failed', error_message = ?,
                 updated_at = datetime('now')
             WHERE id = ?`
          ).run(err.message.slice(0, 500), msg.id);
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
      limit:     { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      method:    { type: 'string' },
    },
    strict: false,
  });

  const methods = args.method
    ? [args.method]
    : ['email', 'sms'];

  runOutreachStage({
    limit:   args.limit ? parseInt(args.limit, 10) : undefined,
    dryRun:  args['dry-run'],
    methods,
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
