#!/usr/bin/env node

/**
 * 2Step Store — Accept Claude-generated results on stdin, write to DB.
 *
 * Usage:
 *   echo '{"batch_type":"classify_replies","results":[...]}' | node scripts/2step-store.js
 *
 * Or pipe from claude:
 *   claude -p "..." | node scripts/2step-store.js
 *
 * Expected input format (JSON on stdin):
 *   {
 *     "batch_type": "proposals_email|proposals_sms|classify_replies|extract_names|reply_responses|proofread|oversee",
 *     "results": [ ... ]
 *   }
 */

import '../src/utils/load-env.js';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spin } from '../../../333Method/src/utils/spintax.js';
import { addCountryCode } from '../../../333Method/src/utils/phone-normalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dbPath = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const messagesDbPath = process.env.MESSAGES_DB_PATH
  || resolve(root, '../mmo-platform/db/messages.db');

// Open DB read-write
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');
db.pragma('foreign_keys = ON');

if (existsSync(messagesDbPath)) {
  db.exec(`ATTACH DATABASE '${messagesDbPath}' AS msgs`);
} else {
  console.error(`[2step-store] messages.db not found at ${messagesDbPath}`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ─── Store Handlers ──────────────────────────────────────────────────────────

function storeProposal(item) {
  if (!item.contact_method) {
    console.error(`[store] Missing contact_method for site ${item.site_id} — skipping`);
    return;
  }
  const contactMethod = item.contact_method;
  let contactUri = item.contact_uri || '';

  // Normalize phone numbers
  if (contactMethod === 'sms' && contactUri && item.country_code) {
    try {
      contactUri = addCountryCode(contactUri, item.country_code);
    } catch { /* keep original */ }
  }

  // Look up active pricing
  const pricing = db.prepare(`
    SELECT id FROM msgs.pricing
    WHERE project = '2step' AND country_code = ? AND superseded_at IS NULL
    LIMIT 1
  `).get(item.country_code);

  const pricingId = pricing?.id || null;
  const videoUrl = item.video_url || null;

  // Insert outreach message
  const insertMsg = db.prepare(`
    INSERT INTO msgs.messages (
      project, site_id, direction, contact_method, contact_uri,
      message_body, subject_line, video_url,
      approval_status, message_type, pricing_id, template_id,
      created_at, updated_at
    ) VALUES (
      '2step', ?, 'outbound', ?, ?,
      ?, ?, ?,
      'pending', ?, ?, ?,
      datetime('now'), datetime('now')
    )
  `);

  // Insert initial outreach
  insertMsg.run(
    item.site_id, contactMethod, contactUri,
    item.message_body, item.subject_line || null, videoUrl,
    'outreach', pricingId, item.template_id || null
  );

  // Insert followup1 if provided
  if (item.followup1_body) {
    insertMsg.run(
      item.site_id, contactMethod, contactUri,
      item.followup1_body, item.followup1_subject || null, videoUrl,
      'followup1', pricingId, item.template_id || null
    );
  }

  // Insert followup2 if provided
  if (item.followup2_body) {
    insertMsg.run(
      item.site_id, contactMethod, contactUri,
      item.followup2_body, item.followup2_subject || null, videoUrl,
      'followup2', pricingId, item.template_id || null
    );
  }

  // Update site status
  db.prepare(`
    UPDATE sites SET status = 'proposals_drafted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'video_created'
  `).run(item.site_id);
}

function storeClassifyReply(item) {
  db.prepare(`
    UPDATE msgs.messages
    SET intent = ?, sentiment = ?, processed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND project = '2step'
  `).run(item.intent, item.sentiment || 'neutral', item.message_id);

  // Update site conversation_status based on intent
  if (item.intent === 'opt-out') {
    db.prepare(`
      UPDATE sites SET conversation_status = 'not_interested', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(item.site_id);
  } else if (item.intent === 'interested' || item.intent === 'pricing' || item.intent === 'schedule') {
    db.prepare(`
      UPDATE sites SET conversation_status = 'interested', status = 'interested', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(item.site_id);
  }
}

function storeReplyResponse(item) {
  const contactMethod = item.channel || 'email';
  let contactUri = item.contact_uri || '';

  // Insert the reply message
  db.prepare(`
    INSERT INTO msgs.messages (
      project, site_id, direction, contact_method, contact_uri,
      message_body, subject_line,
      approval_status, message_type,
      created_at, updated_at
    ) VALUES (
      '2step', ?, 'outbound', ?, ?,
      ?, ?,
      'approved', 'reply',
      datetime('now'), datetime('now')
    )
  `).run(
    item.site_id, contactMethod, contactUri,
    item.reply_body, item.reply_subject || null
  );

  // Update site conversation status
  db.prepare(`
    UPDATE sites SET conversation_status = 'replied', status = 'replied', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(item.site_id);
}

function storeExtractName(item) {
  if (item.first_name) {
    db.prepare(`
      UPDATE sites SET owner_first_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(item.first_name, item.site_id);
  }
}

function storeProofread(item) {
  // Opus proofreader returns: approved, rework, or rejected
  const status = item.approval_status || 'approved';

  const updates = {
    approved: () => {
      db.prepare(`
        UPDATE msgs.messages
        SET approval_status = 'approved', updated_at = datetime('now')
        WHERE id = ? AND project = '2step'
      `).run(item.message_id);
    },
    rework: () => {
      db.prepare(`
        UPDATE msgs.messages
        SET approval_status = 'rework', rework_instructions = ?, updated_at = datetime('now')
        WHERE id = ? AND project = '2step'
      `).run(item.rework_instructions || '', item.message_id);
    },
    rejected: () => {
      db.prepare(`
        UPDATE msgs.messages
        SET approval_status = 'rejected', rework_instructions = ?, updated_at = datetime('now')
        WHERE id = ? AND project = '2step'
      `).run(item.rework_instructions || 'Rejected by proofreader', item.message_id);
    },
  };

  (updates[status] || updates.rejected)();
}

function storeOversee(item) {
  // Overseer can issue actions
  if (!item.actions) return;

  for (const action of item.actions) {
    switch (action.type) {
      case 'RESET_STUCK_SITES': {
        const stuckSites = db.prepare(`
          SELECT id, status FROM sites
          WHERE status = ? AND updated_at < datetime('now', '-4 hours')
        `).all(action.from_status || 'enriched');

        for (const site of stuckSites) {
          db.prepare(`
            UPDATE sites SET status = ?, error_message = 'Reset by overseer', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(action.to_status || 'reviews_downloaded', site.id);
        }
        console.log(`[oversee] Reset ${stuckSites.length} stuck sites from ${action.from_status} to ${action.to_status}`);
        break;
      }
      default:
        console.log(`[oversee] Unknown action: ${action.type}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const storeHandlers = {
  proposals_email: storeProposal,
  proposals_sms: storeProposal,
  proofread: storeProofread,
  classify_replies: storeClassifyReply,
  reply_responses: storeReplyResponse,
  extract_names: storeExtractName,
  oversee: storeOversee,
};

async function main() {
  const raw = await readStdin();

  // Try to parse as JSON
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract JSON from markdown code blocks (claude sometimes wraps output)
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      console.error('[2step-store] Could not parse stdin as JSON');
      process.exit(1);
    }
  }

  const { batch_type, results } = parsed;

  if (!batch_type || !results || !Array.isArray(results)) {
    console.error('[2step-store] Expected { batch_type, results: [...] }');
    process.exit(1);
  }

  const handler = storeHandlers[batch_type];
  if (!handler) {
    console.error(`[2step-store] Unknown batch type: ${batch_type}`);
    console.error(`Valid types: ${Object.keys(storeHandlers).join(', ')}`);
    process.exit(1);
  }

  console.log(`[2step-store] Processing ${results.length} ${batch_type} results...`);

  let stored = 0;
  let errors = 0;

  const storeAll = db.transaction(() => {
    for (const item of results) {
      try {
        handler(item);
        stored++;
      } catch (err) {
        console.error(`[2step-store] Error storing item: ${err.message}`);
        errors++;
      }
    }
  });

  storeAll();

  console.log(`[2step-store] Done: ${stored} stored, ${errors} errors`);

  db.close();
}

main().catch(err => {
  console.error(`[2step-store] Fatal: ${err.message}`);
  process.exit(1);
});
