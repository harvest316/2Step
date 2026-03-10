#!/usr/bin/env node

/**
 * Email outreach for 2Step — sends video demo emails via Resend.
 *
 * Includes thumbnail with play button overlay linking to video URL.
 * CAN-SPAM compliant with unsubscribe link.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_EMAIL = process.env.TWOSTEP_SENDER_EMAIL || 'videos@auditandfix.com';
const SENDER_NAME = process.env.TWOSTEP_SENDER_NAME || '2Step Video Reviews';
const UNSUBSCRIBE_URL = process.env.UNSUBSCRIBE_WORKER_URL || 'https://unsubscribe-worker.auditandfix.workers.dev';

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

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function getPendingEmails() {
  if (args.id) {
    return db.prepare(`
      SELECT o.*, p.business_name, p.city, p.niche, v.video_url
      FROM outreaches o
      JOIN prospects p ON p.id = o.prospect_id
      LEFT JOIN videos v ON v.id = o.video_id
      WHERE o.id = ? AND o.channel = 'email'
    `).all(parseInt(args.id, 10));
  }

  return db.prepare(`
    SELECT o.*, p.business_name, p.city, p.niche, v.video_url
    FROM outreaches o
    JOIN prospects p ON p.id = o.prospect_id
    LEFT JOIN videos v ON v.id = o.video_id
    WHERE o.channel = 'email'
      AND o.delivery_status = 'pending'
    ORDER BY o.created_at ASC
    LIMIT ?
  `).all(parseInt(args.limit, 10));
}

// ─── Email Template ──────────────────────────────────────────────────────────

function buildEmailHtml(outreach) {
  const videoUrl = outreach.video_url || '#';
  const businessName = outreach.business_name;

  // Thumbnail with play button overlay — links to video
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">

${outreach.message_body.split('\n').map(line => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${line}</p>`).join('\n')}

<div style="margin: 24px 0; text-align: center;">
  <a href="${videoUrl}" style="display: inline-block; position: relative; text-decoration: none;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 40px 60px; color: white; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 8px;">▶</div>
      <div style="font-size: 16px; font-weight: 600;">Watch Your Video Review</div>
      <div style="font-size: 13px; opacity: 0.8; margin-top: 4px;">${businessName} — 30 second preview</div>
    </div>
  </a>
</div>

<p style="font-size: 12px; color: #999; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px;">
  You're receiving this because we thought ${businessName} deserved to see their great reviews turned into video.
  <a href="${UNSUBSCRIBE_URL}?email=${encodeURIComponent(outreach.contact_uri)}" style="color: #999;">Unsubscribe</a>
</p>

</body>
</html>`;
}

function buildSubject(outreach) {
  return `We made a video from your best Google review — ${outreach.business_name}`;
}

// ─── Send ────────────────────────────────────────────────────────────────────

async function sendOne(outreach) {
  const html = buildEmailHtml(outreach);
  const subject = buildSubject(outreach);

  if (args['dry-run']) {
    console.log(`  To: ${outreach.contact_uri}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Video: ${outreach.video_url || '(none)'}`);
    console.log('  ---');
    return { success: true, dryRun: true };
  }

  const { data, error } = await resend.emails.send({
    from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
    to: outreach.contact_uri,
    subject,
    html,
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
