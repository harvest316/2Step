#!/usr/bin/env node

/**
 * DM message generator — creates unique outreach messages via LLM.
 *
 * Uses `claude -p` (Claude Max, zero cost) to generate a unique,
 * natural-sounding DM for each prospect. Output is copy-paste ready.
 *
 * Usage:
 *   node src/outreach/dm-generator.js                    # All sites with completed videos
 *   node src/outreach/dm-generator.js --limit 5          # Up to 5
 *   node src/outreach/dm-generator.js --id 3             # Specific site
 *   node src/outreach/dm-generator.js --channel email    # Generate email-style messages
 */

import '../utils/load-env.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseArgs } from 'util';
import { getAll, run, withTransaction } from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

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

async function getSitesWithVideos() {
  if (args.id) {
    return await getAll(
      `SELECT s.*, v.video_url, v.id as video_id
       FROM sites s
       JOIN videos v ON v.site_id = s.id
       WHERE s.id = $1 AND v.status = 'completed' AND v.video_url IS NOT NULL
       ORDER BY v.created_at DESC
       LIMIT 1`,
      [parseInt(args.id, 10)]
    );
  }

  return await getAll(
    `SELECT s.*, v.video_url, v.id as video_id
     FROM sites s
     JOIN videos v ON v.site_id = s.id
     WHERE s.status IN ('video_created', 'video_prompted')
       AND v.status = 'completed'
       AND v.video_url IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM msgs.messages m
         WHERE m.project = '2step'
           AND m.site_id = s.id
           AND m.contact_method = $1
       )
     ORDER BY s.google_rating DESC
     LIMIT $2`,
    [args.channel, parseInt(args.limit, 10)]
  );
}

// ─── Message Generation ─────────────────────────────────────────────────────

function buildPrompt(site) {
  // Support both legacy best_review_text and new selected_review_json
  let reviewSnippet = 'great service and quality';
  if (site.selected_review_json) {
    try {
      const parsed = JSON.parse(site.selected_review_json);
      reviewSnippet = (parsed.text || parsed.review_text || reviewSnippet).substring(0, 200);
    } catch (_) { /* fall through to best_review_text */ }
  }
  if (reviewSnippet === 'great service and quality' && site.best_review_text) {
    reviewSnippet = site.best_review_text.substring(0, 200);
  }

  return PROMPT_TEMPLATE
    .replace(/\{\{business_name\}\}/g, site.business_name)
    .replace(/\{\{owner_first_name\}\}/g, site.owner_first_name || 'there')
    .replace(/\{\{niche\}\}/g, site.niche || 'local business')
    .replace(/\{\{city\}\}/g, site.city || 'your area')
    .replace(/\{\{review_snippet\}\}/g, reviewSnippet)
    .replace(/\{\{video_url\}\}/g, site.video_url);
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

function getContactUri(site, channel) {
  switch (channel) {
    case 'email': return site.email;
    case 'instagram_dm': return site.instagram_handle;
    case 'facebook_dm': return site.facebook_page_url;
    default: return site.email || site.instagram_handle;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sites = await getSitesWithVideos();

if (sites.length === 0) {
  console.log('No sites with completed videos ready for outreach.');
  console.log('Make sure videos have status=completed and video_url set.');
  process.exit(0);
}

console.log(`Generating ${args.channel} messages for ${sites.length} sites...\n`);

let success = 0;

for (const site of sites) {
  try {
    console.log(`[${site.id}] ${site.business_name}...`);

    const prompt = buildPrompt(site);
    const message = generateMessage(prompt);
    const contactUri = getContactUri(site, args.channel);

    if (!contactUri) {
      console.log(`  No ${args.channel} contact info — skipping`);
      continue;
    }

    if (args['dry-run']) {
      console.log(`  Contact: ${contactUri}`);
      console.log(`  Message:\n${message}\n`);
      console.log('  ---');
    } else {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO msgs.messages
             (project, site_id, direction, contact_method, contact_uri, message_body, approval_status)
           VALUES ('2step', $1, 'outbound', $2, $3, $4, 'pending')`,
          [site.id, args.channel, contactUri, message]
        );
      });
      console.log(`  Message generated for ${contactUri}`);
    }

    // Always print the message for copy-paste
    if (!args['dry-run']) {
      console.log(`\n  --- COPY-PASTE for ${site.business_name} (${contactUri}) ---`);
      console.log(`  ${message}`);
      console.log('  ---\n');
    }

    success++;
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  }
}

console.log(`\nDone: ${success} messages generated`);
