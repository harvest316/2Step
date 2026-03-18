#!/usr/bin/env node

/**
 * 2Step Batch — Pull work from DB and output JSON for Claude processing.
 *
 * Usage:
 *   node scripts/2step-batch.js <batch_type> [limit]
 *
 * Batch types:
 *   proposals_email   — Sites needing email proposals (video_created, has email contact)
 *   proposals_sms     — Sites needing SMS proposals (video_created, has phone contact)
 *   proofread         — Pending 2Step proposals needing proofreading
 *   classify_replies  — Inbound 2Step messages needing intent classification
 *   reply_responses   — Classified inbound messages needing a sales reply
 *   extract_names     — Sites missing owner first name
 *   oversee           — System health snapshot for overseer
 *
 * Outputs JSON to stdout. The unified orchestrator pipes this to `claude -p`.
 */

import '../src/utils/load-env.js';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dbPath = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const messagesDbPath = process.env.MESSAGES_DB_PATH
  || resolve(root, '../mmo-platform/db/messages.db');

const [, , batchType, limitArg] = process.argv;
const limit = parseInt(limitArg || '10', 10);

if (!batchType) {
  console.error(
    'Usage: node scripts/2step-batch.js <batch_type> [limit]\n' +
    'Types: proposals_email, proposals_sms, proofread, classify_replies, reply_responses, extract_names, oversee'
  );
  process.exit(1);
}

// Open 2step.db read-only + ATTACH messages.db
const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');

if (existsSync(messagesDbPath)) {
  db.exec(`ATTACH DATABASE '${messagesDbPath}' AS msgs`);
} else {
  console.error(`[2step-batch] messages.db not found at ${messagesDbPath}`);
  process.exit(1);
}

// ─── Batch Handlers ──────────────────────────────────────────────────────────

function fetchProposalsBatch(channel) {
  const contactMethod = channel === 'email' ? 'email' : 'sms';
  const contactField = channel === 'email' ? '$.emails' : '$.phones';

  const sites = db.prepare(`
    SELECT s.id, s.business_name, s.domain, s.website_url, s.city, s.state,
           s.country_code, s.niche, s.contacts_json, s.video_url, s.video_hash,
           s.selected_review_json, s.problem_category, s.owner_first_name,
           s.google_rating, s.review_count
    FROM sites s
    WHERE s.status = 'video_created'
      AND s.video_url IS NOT NULL
      AND (
        json_array_length(s.contacts_json, ?) > 0
        OR EXISTS (
          SELECT 1 FROM json_each(s.contacts_json, '$.contacts')
          WHERE json_extract(value, '$.type') = ?
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM msgs.messages m
        WHERE m.project = '2step'
          AND m.site_id = s.id
          AND m.contact_method = ?
          AND m.direction = 'outbound'
          AND m.message_type = 'outreach'
      )
    ORDER BY s.id ASC
    LIMIT ?
  `).all(contactField, contactMethod, contactMethod, limit);

  return sites.map(site => {
    const contacts = site.contacts_json ? JSON.parse(site.contacts_json) : {};
    const review = site.selected_review_json ? JSON.parse(site.selected_review_json) : {};

    return {
      site_id: site.id,
      business_name: site.business_name,
      domain: site.domain,
      city: site.city,
      state: site.state,
      country_code: site.country_code,
      niche: site.niche,
      problem_category: site.problem_category,
      video_url: `https://auditandfix.com/v/${site.video_hash}`,
      review_author: review.author || 'a customer',
      review_snippet: (review.text || '').slice(0, 200),
      owner_first_name: site.owner_first_name || null,
      google_rating: site.google_rating,
      review_count: site.review_count,
      channel: contactMethod,
      contacts,
    };
  });
}

function fetchProofreadBatch() {
  const messages = db.prepare(`
    SELECT m.id, m.site_id, m.contact_method, m.contact_uri,
           m.message_body, m.subject_line, m.video_url,
           m.message_type, m.template_id
    FROM msgs.messages m
    WHERE m.project = '2step'
      AND m.direction = 'outbound'
      AND m.approval_status = 'pending'
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(limit);

  return messages.map(msg => {
    // Join to sites for context
    const site = db.prepare('SELECT business_name, city, country_code, niche FROM sites WHERE id = ?')
      .get(msg.site_id);

    return {
      message_id: msg.id,
      site_id: msg.site_id,
      channel: msg.contact_method,
      contact_uri: msg.contact_uri,
      message_type: msg.message_type,
      subject_line: msg.subject_line,
      message_body: msg.message_body,
      video_url: msg.video_url,
      business_name: site?.business_name || 'Unknown',
      city: site?.city,
      country_code: site?.country_code,
      niche: site?.niche,
    };
  });
}

function fetchClassifyReplies() {
  const messages = db.prepare(`
    SELECT m.id, m.site_id, m.contact_method, m.contact_uri,
           m.message_body, m.raw_payload, m.created_at
    FROM msgs.messages m
    WHERE m.project = '2step'
      AND m.direction = 'inbound'
      AND m.processed_at IS NULL
      AND m.intent IS NULL
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(limit);

  return messages.map(msg => {
    const site = db.prepare('SELECT business_name, city, niche FROM sites WHERE id = ?')
      .get(msg.site_id);

    // Get conversation history
    const history = db.prepare(`
      SELECT direction, message_body, contact_method, sent_at, created_at
      FROM msgs.messages
      WHERE project = '2step' AND site_id = ?
      ORDER BY created_at ASC
    `).all(msg.site_id);

    return {
      message_id: msg.id,
      site_id: msg.site_id,
      channel: msg.contact_method,
      contact_uri: msg.contact_uri,
      message_body: msg.message_body,
      business_name: site?.business_name || 'Unknown',
      niche: site?.niche,
      conversation_history: history.map(h => ({
        direction: h.direction,
        body: h.message_body,
        channel: h.contact_method,
        at: h.sent_at || h.created_at,
      })),
    };
  });
}

function fetchReplyResponses() {
  const messages = db.prepare(`
    SELECT m.id, m.site_id, m.contact_method, m.contact_uri,
           m.message_body, m.intent, m.sentiment, m.created_at
    FROM msgs.messages m
    WHERE m.project = '2step'
      AND m.direction = 'inbound'
      AND m.processed_at IS NOT NULL
      AND m.intent IS NOT NULL
      AND m.intent NOT IN ('opt-out', 'autoresponder')
      AND NOT EXISTS (
        SELECT 1 FROM msgs.messages r
        WHERE r.project = '2step'
          AND r.site_id = m.site_id
          AND r.direction = 'outbound'
          AND r.message_type = 'reply'
          AND r.created_at > m.created_at
      )
    ORDER BY m.created_at ASC
    LIMIT ?
  `).all(limit);

  return messages.map(msg => {
    const site = db.prepare(`
      SELECT business_name, city, country_code, niche, video_url, video_hash
      FROM sites WHERE id = ?
    `).get(msg.site_id);

    // Full conversation history
    const history = db.prepare(`
      SELECT direction, message_body, contact_method, message_type, intent, sent_at, created_at
      FROM msgs.messages
      WHERE project = '2step' AND site_id = ?
      ORDER BY created_at ASC
    `).all(msg.site_id);

    // Get pricing for this site's country + niche tier
    const pricing = db.prepare(`
      SELECT * FROM msgs.pricing
      WHERE project = '2step' AND country_code = ? AND superseded_at IS NULL
      LIMIT 3
    `).all(site?.country_code || 'AU');

    return {
      message_id: msg.id,
      site_id: msg.site_id,
      channel: msg.contact_method,
      contact_uri: msg.contact_uri,
      inbound_body: msg.message_body,
      intent: msg.intent,
      sentiment: msg.sentiment,
      business_name: site?.business_name || 'Unknown',
      city: site?.city,
      country_code: site?.country_code,
      niche: site?.niche,
      video_url: site?.video_hash ? `https://auditandfix.com/v/${site.video_hash}` : site?.video_url,
      pricing: pricing.map(p => ({
        tier: p.niche_tier,
        setup: p.setup_local,
        monthly_4: p.monthly_4,
        monthly_8: p.monthly_8,
        monthly_12: p.monthly_12,
        currency: p.currency,
      })),
      conversation_history: history.map(h => ({
        direction: h.direction,
        body: h.message_body,
        channel: h.contact_method,
        type: h.message_type,
        intent: h.intent,
        at: h.sent_at || h.created_at,
      })),
    };
  });
}

function fetchExtractNames() {
  const sites = db.prepare(`
    SELECT id, business_name, email, contacts_json
    FROM sites
    WHERE owner_first_name IS NULL
      AND status IN ('reviews_downloaded', 'enriched', 'video_created', 'proposals_drafted')
      AND (email IS NOT NULL OR contacts_json IS NOT NULL)
    ORDER BY id ASC
    LIMIT ?
  `).all(limit);

  return sites.map(site => {
    const contacts = site.contacts_json ? JSON.parse(site.contacts_json) : {};
    const emails = contacts.emails || contacts.email_addresses || [];
    const allEmails = [site.email, ...emails.map(e => e.email || e)].filter(Boolean);

    return {
      site_id: site.id,
      business_name: site.business_name,
      emails: allEmails,
      contacts_json_summary: {
        has_socials: !!(contacts.socials?.instagram || contacts.socials?.facebook),
        has_about_page: !!contacts.about_page_text,
      },
    };
  });
}

function fetchOversee() {
  // Pipeline health snapshot
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM sites GROUP BY status ORDER BY count DESC
  `).all();

  const messageCounts = db.prepare(`
    SELECT
      approval_status,
      delivery_status,
      message_type,
      COUNT(*) as count
    FROM msgs.messages
    WHERE project = '2step'
    GROUP BY approval_status, delivery_status, message_type
  `).all();

  const recentErrors = db.prepare(`
    SELECT id, business_name, status, error_message, updated_at
    FROM sites
    WHERE error_message IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();

  const recentInbound = db.prepare(`
    SELECT m.id, m.site_id, m.contact_method, m.intent, m.sentiment, m.created_at
    FROM msgs.messages m
    WHERE m.project = '2step' AND m.direction = 'inbound'
    ORDER BY m.created_at DESC
    LIMIT 10
  `).all();

  return [{
    pipeline_status: Object.fromEntries(statusCounts.map(r => [r.status, r.count])),
    message_summary: messageCounts,
    recent_errors: recentErrors,
    recent_inbound: recentInbound,
    timestamp: new Date().toISOString(),
  }];
}

/**
 * followup_check — Queue approved followup messages whose send window has arrived.
 * Uses a separate writable connection since the module-level db is read-only.
 */
function fetchFollowupCheck() {
  const rwDb = new Database(dbPath);
  rwDb.pragma('journal_mode = WAL');
  rwDb.pragma('busy_timeout = 10000');

  if (existsSync(messagesDbPath)) {
    rwDb.exec(`ATTACH DATABASE '${messagesDbPath}' AS msgs`);
  }

  let followup1Queued = 0;
  let followup2Queued = 0;

  try {
    const closedStatuses = ['replied', 'interested', 'closed', 'not_interested'];
    const closedPlaceholders = closedStatuses.map(() => '?').join(', ');

    // followup1: 24h after last_outreach_at, conversation still open
    const f1Result = rwDb.prepare(`
      UPDATE msgs.messages
      SET delivery_status = 'queued', updated_at = datetime('now')
      WHERE project = '2step'
        AND message_type = 'followup1'
        AND approval_status = 'approved'
        AND delivery_status IS NULL
        AND sent_at IS NULL
        AND EXISTS (
          SELECT 1 FROM sites s
          WHERE s.id = msgs.messages.site_id
            AND s.followup1_sent_at IS NULL
            AND s.last_outreach_at IS NOT NULL
            AND datetime(s.last_outreach_at, '+24 hours') <= datetime('now')
            AND (s.conversation_status IS NULL
                 OR s.conversation_status NOT IN (${closedPlaceholders}))
        )
    `).run(...closedStatuses);

    followup1Queued = f1Result.changes;

    // followup2: 3 days after followup1_sent_at, conversation still open
    const f2Result = rwDb.prepare(`
      UPDATE msgs.messages
      SET delivery_status = 'queued', updated_at = datetime('now')
      WHERE project = '2step'
        AND message_type = 'followup2'
        AND approval_status = 'approved'
        AND delivery_status IS NULL
        AND sent_at IS NULL
        AND EXISTS (
          SELECT 1 FROM sites s
          WHERE s.id = msgs.messages.site_id
            AND s.followup2_sent_at IS NULL
            AND s.followup1_sent_at IS NOT NULL
            AND datetime(s.followup1_sent_at, '+3 days') <= datetime('now')
            AND (s.conversation_status IS NULL
                 OR s.conversation_status NOT IN (${closedPlaceholders}))
        )
    `).run(...closedStatuses);

    followup2Queued = f2Result.changes;
  } finally {
    rwDb.close();
  }

  const total = followup1Queued + followup2Queued;
  if (total === 0) return [];

  return [{
    followup1_queued: followup1Queued,
    followup2_queued: followup2Queued,
    total_queued: total,
  }];
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const handlers = {
  proposals_email: () => fetchProposalsBatch('email'),
  proposals_sms: () => fetchProposalsBatch('sms'),
  proofread: fetchProofreadBatch,
  classify_replies: fetchClassifyReplies,
  reply_responses: fetchReplyResponses,
  extract_names: fetchExtractNames,
  oversee: fetchOversee,
  followup_check: fetchFollowupCheck,
};

const handler = handlers[batchType];
if (!handler) {
  console.error(`Unknown batch type: ${batchType}`);
  console.error(`Valid types: ${Object.keys(handlers).join(', ')}`);
  process.exit(1);
}

const items = handler();
console.log(JSON.stringify(items, null, 2));

db.close();
