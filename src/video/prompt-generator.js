#!/usr/bin/env node

/**
 * Video prompt generator — creates video scripts from prospect reviews.
 *
 * Uses `claude -p` (Claude Max, zero cost) to generate scene-by-scene
 * video scripts for each prospect with status='found'.
 *
 * Usage:
 *   node src/video/prompt-generator.js              # Process all 'found' prospects
 *   node src/video/prompt-generator.js --limit 5    # Process up to 5
 *   node src/video/prompt-generator.js --id 3       # Process specific prospect
 *   node src/video/prompt-generator.js --tool holo  # Set video_tool (default: invideo)
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

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function getProspects() {
  if (args.id) {
    const row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(parseInt(args.id, 10));
    return row ? [row] : [];
  }
  return db.prepare(
    'SELECT * FROM prospects WHERE status = ? AND best_review_text IS NOT NULL ORDER BY google_rating DESC LIMIT ?'
  ).all('found', parseInt(args.limit, 10));
}

// ─── Prompt Generation ──────────────────────────────────────────────────────

function buildPrompt(prospect) {
  return PROMPT_TEMPLATE
    .replace(/\{\{business_name\}\}/g, prospect.business_name)
    .replace(/\{\{niche\}\}/g, prospect.niche || 'local business')
    .replace(/\{\{city\}\}/g, prospect.city || 'their area')
    .replace(/\{\{review_author\}\}/g, prospect.best_review_author || 'A Customer')
    .replace(/\{\{review_text\}\}/g, prospect.best_review_text);
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

const prospects = getProspects();

if (prospects.length === 0) {
  console.log('No prospects with status=found and a review. Run outscraper.js first.');
  process.exit(0);
}

console.log(`Generating video prompts for ${prospects.length} prospects (tool: ${videoTool})...\n`);

const insertVideo = db.prepare(`
  INSERT INTO videos (prospect_id, video_tool, prompt_text, status)
  VALUES (?, ?, ?, 'prompted')
`);

const updateStatus = db.prepare(`
  UPDATE prospects SET status = 'video_prompted', updated_at = CURRENT_TIMESTAMP WHERE id = ?
`);

let success = 0;
let failed = 0;

for (const prospect of prospects) {
  try {
    console.log(`[${prospect.id}] ${prospect.business_name} (${prospect.city})...`);

    const prompt = buildPrompt(prospect);
    const script = generateVideoScript(prompt);

    db.transaction(() => {
      insertVideo.run(prospect.id, videoTool, script);
      updateStatus.run(prospect.id);
    })();

    console.log(`  ✓ Video script generated (${script.length} chars)`);
    success++;
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
    db.prepare(
      'UPDATE prospects SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(err.message, prospect.id);
    failed++;
  }
}

db.close();
console.log(`\nDone: ${success} generated, ${failed} failed`);
