#!/usr/bin/env node

/**
 * Video prompt generator — creates video scripts from site reviews.
 *
 * Uses `claude -p` (Claude Max, zero cost) to generate scene-by-scene
 * video scripts for each site with status='found'.
 *
 * Usage:
 *   node src/video/prompt-generator.js              # Process all 'found' sites
 *   node src/video/prompt-generator.js --limit 5    # Process up to 5
 *   node src/video/prompt-generator.js --id 3       # Process specific site
 *   node src/video/prompt-generator.js --tool holo  # Set video_tool (default: invideo)
 */

import '../utils/load-env.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseArgs } from 'util';
import db from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const PROMPT_TEMPLATE = readFileSync(resolve(root, 'prompts/VIDEO-PROMPT.md'), 'utf8');

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '50' },
    id: { type: 'string' },
    tool: { type: 'string', default: 'invideo' },
  },
  strict: false,
});

const VALID_TOOLS = ['invideo', 'holo', 'creatomate', 'fliki'];
const videoTool = args.tool;
if (!VALID_TOOLS.includes(videoTool)) {
  console.error(`Invalid --tool. Must be one of: ${VALID_TOOLS.join(', ')}`);
  process.exit(1);
}

// ─── Database ────────────────────────────────────────────────────────────────

function getSites() {
  if (args.id) {
    const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(parseInt(args.id, 10));
    return row ? [row] : [];
  }
  return db.prepare(
    'SELECT * FROM sites WHERE status = ? AND best_review_text IS NOT NULL ORDER BY google_rating DESC LIMIT ?'
  ).all('found', parseInt(args.limit, 10));
}

// ─── Prompt Generation ──────────────────────────────────────────────────────

function buildPrompt(site) {
  // Support both legacy best_review_text and new selected_review_json
  let reviewText = site.best_review_text || '';
  let reviewAuthor = site.best_review_author || 'A Customer';
  if (site.selected_review_json) {
    try {
      const parsed = JSON.parse(site.selected_review_json);
      reviewText = parsed.text || parsed.review_text || reviewText;
      reviewAuthor = parsed.author_name || parsed.author || reviewAuthor;
    } catch (_) { /* fall through to best_review_text */ }
  }

  return PROMPT_TEMPLATE
    .replace(/\{\{business_name\}\}/g, site.business_name)
    .replace(/\{\{niche\}\}/g, site.niche || 'local business')
    .replace(/\{\{city\}\}/g, site.city || 'their area')
    .replace(/\{\{review_author\}\}/g, reviewAuthor)
    .replace(/\{\{review_text\}\}/g, reviewText);
}

function generateVideoScript(prompt) {
  // Use claude -p (Claude Max subscription, zero API cost)
  const escaped = prompt.replace(/'/g, "'\\''");
  const result = execSync(`echo '${escaped}' | env -u CLAUDECODE claude -p`, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return result.trim();
}

// ─── Main ────────────────────────────────────────────────────────────────────

const sites = getSites();

if (sites.length === 0) {
  console.log('No sites with status=found and a review. Run outscraper.js first.');
  process.exit(0);
}

console.log(`Generating video prompts for ${sites.length} sites (tool: ${videoTool})...\n`);

const insertVideo = db.prepare(`
  INSERT INTO videos (site_id, video_tool, prompt_text, status)
  VALUES (?, ?, ?, 'prompted')
`);

const updateStatus = db.prepare(`
  UPDATE sites SET status = 'video_prompted', updated_at = CURRENT_TIMESTAMP WHERE id = ?
`);

let success = 0;
let failed = 0;

for (const site of sites) {
  try {
    console.log(`[${site.id}] ${site.business_name} (${site.city})...`);

    const prompt = buildPrompt(site);
    const script = generateVideoScript(prompt);

    db.transaction(() => {
      insertVideo.run(site.id, videoTool, script);
      updateStatus.run(site.id);
    })();

    console.log(`  ✓ Video script generated (${script.length} chars)`);
    success++;
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
    db.prepare(
      'UPDATE sites SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(err.message, site.id);
    failed++;
  }
}

console.log(`\nDone: ${success} generated, ${failed} failed`);
