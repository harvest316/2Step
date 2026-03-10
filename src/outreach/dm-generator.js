#!/usr/bin/env node

/**
 * DM message generator — creates unique outreach messages via LLM.
 *
 * Uses `claude -p` (Claude Max, zero cost) to generate a unique,
 * natural-sounding DM for each prospect. Output is copy-paste ready.
 *
 * Usage:
 *   node src/outreach/dm-generator.js                    # All prospects with completed videos
 *   node src/outreach/dm-generator.js --limit 5          # Up to 5
 *   node src/outreach/dm-generator.js --id 3             # Specific prospect
 *   node src/outreach/dm-generator.js --channel email    # Generate email-style messages
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const PROMPT_TEMPLATE = readFileSync(resolve(root, 'prompts/DM-OUTREACH.md'), 'utf8');

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '50' },
    id: { type: 'string' },
    channel: { type: 'string', default: 'instagram_dm' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: false,
});

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function getProspectsWithVideos() {
  if (args.id) {
    return db.prepare(`
      SELECT p.*, v.video_url, v.id as video_id
      FROM prospects p
      JOIN videos v ON v.prospect_id = p.id
      WHERE p.id = ? AND v.status = 'completed' AND v.video_url IS NOT NULL
      ORDER BY v.created_at DESC
      LIMIT 1
    `).all(parseInt(args.id, 10));
  }

  return db.prepare(`
    SELECT p.*, v.video_url, v.id as video_id
    FROM prospects p
    JOIN videos v ON v.prospect_id = p.id
    WHERE p.status IN ('video_created', 'video_prompted')
      AND v.status = 'completed'
      AND v.video_url IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM outreaches o
        WHERE o.prospect_id = p.id AND o.channel = ?
      )
    ORDER BY p.google_rating DESC
    LIMIT ?
  `).all(args.channel, parseInt(args.limit, 10));
}

// ─── Message Generation ─────────────────────────────────────────────────────

function buildPrompt(prospect) {
  const reviewSnippet = prospect.best_review_text
    ? prospect.best_review_text.substring(0, 200)
    : 'great service and quality';

  return PROMPT_TEMPLATE
    .replace(/\{\{business_name\}\}/g, prospect.business_name)
    .replace(/\{\{owner_first_name\}\}/g, prospect.owner_first_name || 'there')
    .replace(/\{\{niche\}\}/g, prospect.niche || 'local business')
    .replace(/\{\{city\}\}/g, prospect.city || 'your area')
    .replace(/\{\{review_snippet\}\}/g, reviewSnippet)
    .replace(/\{\{video_url\}\}/g, prospect.video_url);
}

function generateMessage(prompt) {
  const escaped = prompt.replace(/'/g, "'\\''");
  const result = execSync(`echo '${escaped}' | claude -p`, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return result.trim();
}

function getContactUri(prospect, channel) {
  switch (channel) {
    case 'email': return prospect.email;
    case 'instagram_dm': return prospect.instagram_handle;
    case 'facebook_dm': return prospect.facebook_page_url;
    default: return prospect.email || prospect.instagram_handle;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const prospects = getProspectsWithVideos();

if (prospects.length === 0) {
  console.log('No prospects with completed videos ready for outreach.');
  console.log('Make sure videos have status=completed and video_url set.');
  process.exit(0);
}

console.log(`Generating ${args.channel} messages for ${prospects.length} prospects...\n`);

const insertOutreach = db.prepare(`
  INSERT INTO outreaches (prospect_id, video_id, channel, contact_uri, message_body, delivery_status)
  VALUES (?, ?, ?, ?, ?, 'pending')
`);

const updateStatus = db.prepare(`
  UPDATE prospects SET status = 'outreach_sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?
`);

let success = 0;

for (const prospect of prospects) {
  try {
    console.log(`[${prospect.id}] ${prospect.business_name}...`);

    const prompt = buildPrompt(prospect);
    const message = generateMessage(prompt);
    const contactUri = getContactUri(prospect, args.channel);

    if (!contactUri) {
      console.log(`  ⚠ No ${args.channel} contact info — skipping`);
      continue;
    }

    if (args['dry-run']) {
      console.log(`  Contact: ${contactUri}`);
      console.log(`  Message:\n${message}\n`);
      console.log('  ---');
    } else {
      db.transaction(() => {
        insertOutreach.run(prospect.id, prospect.video_id, args.channel, contactUri, message);
      })();
      console.log(`  ✓ Message generated for ${contactUri}`);
    }

    // Always print the message for copy-paste
    if (!args['dry-run']) {
      console.log(`\n  --- COPY-PASTE for ${prospect.business_name} (${contactUri}) ---`);
      console.log(`  ${message}`);
      console.log('  ---\n');
    }

    success++;
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
  }
}

db.close();
console.log(`\nDone: ${success} messages generated`);
