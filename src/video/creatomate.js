#!/usr/bin/env node

/**
 * Creatomate API video renderer — automated video creation from reviews.
 *
 * Uses the "AI-Generated Story" template (9:16 vertical, 6 scenes).
 * Each scene gets:
 *   - Image description → Stability AI generates the image
 *   - Voiceover text → ElevenLabs generates narration
 *   - Subtitles auto-generated from voiceover
 *
 * Usage:
 *   node src/video/creatomate.js                     # Process all video_prompted prospects
 *   node src/video/creatomate.js --limit 5           # Up to 5
 *   node src/video/creatomate.js --id 3              # Specific prospect
 *   node src/video/creatomate.js --dry-run           # Preview API payload without rendering
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const API_KEY = process.env.CREATOMATE_API_KEY;
const TEMPLATE_ID = process.env.CREATOMATE_TEMPLATE_ID;
const API_URL = 'https://api.creatomate.com/v1/renders';

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '10' },
    id: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    poll: { type: 'boolean', default: true },
  },
  strict: false,
});

if (!API_KEY || !TEMPLATE_ID) {
  console.error('ERROR: CREATOMATE_API_KEY and CREATOMATE_TEMPLATE_ID must be set in .env');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://api.creatomate.com/v1',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function getProspects() {
  if (args.id) {
    return db.prepare(`
      SELECT p.*, v.id as video_id, v.prompt_text
      FROM prospects p
      JOIN videos v ON v.prospect_id = p.id
      WHERE p.id = ? AND v.video_tool = 'creatomate' AND v.status = 'prompted'
    `).all(parseInt(args.id, 10));
  }

  return db.prepare(`
    SELECT p.*, v.id as video_id, v.prompt_text
    FROM prospects p
    JOIN videos v ON v.prospect_id = p.id
    WHERE v.video_tool = 'creatomate'
      AND v.status = 'prompted'
    ORDER BY p.google_rating DESC
    LIMIT ?
  `).all(parseInt(args.limit, 10));
}

// ─── Scene Builder ───────────────────────────────────────────────────────────

/**
 * Build 6 scenes from a prospect's review for the Creatomate template.
 *
 * Scene layout:
 *   1. Hook — "What customers say about [Business]"
 *   2-4. Review text (split into 3 parts)
 *   5. Attribution — "⭐⭐⭐⭐⭐ — [Reviewer Name]"
 *   6. CTA — "[Business] | [City] | Book Now"
 */
function buildScenes(prospect) {
  const name = prospect.business_name;
  const city = prospect.city || 'their area';
  const niche = prospect.niche || 'local services';
  const reviewer = prospect.best_review_author || 'A Customer';
  const review = prospect.best_review_text || '';

  // Split review into ~3 roughly equal chunks for scenes 2-4
  const words = review.split(/\s+/);
  const chunkSize = Math.ceil(words.length / 3);
  const chunks = [
    words.slice(0, chunkSize).join(' '),
    words.slice(chunkSize, chunkSize * 2).join(' '),
    words.slice(chunkSize * 2).join(' '),
  ].filter(c => c.length > 0);

  // Pad to exactly 3 chunks if review is short
  while (chunks.length < 3) {
    chunks.push(`${name} delivers outstanding ${niche} in ${city}.`);
  }

  return {
    // Scene 1: Hook
    'Image-1.source': `A professional ${niche} business storefront in ${city}, clean and modern, welcoming atmosphere`,
    'Voiceover-1.source': `Here's what customers are saying about ${name} in ${city}.`,

    // Scene 2: Review part 1
    'Image-2.source': `A happy customer receiving excellent ${niche} service, professional and friendly`,
    'Voiceover-2.source': chunks[0],

    // Scene 3: Review part 2
    'Image-3.source': `High quality ${niche} work being done professionally, attention to detail`,
    'Voiceover-3.source': chunks[1],

    // Scene 4: Review part 3
    'Image-4.source': `Satisfied customer smiling after receiving ${niche} service, thumbs up`,
    'Voiceover-4.source': chunks[2],

    // Scene 5: Star rating + attribution
    'Image-5.source': `Five gold stars on a dark background, premium quality award, celebration`,
    'Voiceover-5.source': `That was a five star review from ${reviewer}.`,

    // Scene 6: CTA
    'Image-6.source': `Modern ${niche} business logo on a clean gradient background, professional branding`,
    'Voiceover-6.source': `${name}. Proudly serving ${city}. Book now.`,
  };
}

// ─── Render ──────────────────────────────────────────────────────────────────

async function submitRender(prospect) {
  const modifications = buildScenes(prospect);

  const payload = {
    template_id: TEMPLATE_ID,
    modifications,
  };

  if (args['dry-run']) {
    console.log(`  Payload:\n${JSON.stringify(payload, null, 2)}`);
    return { id: 'dry-run', status: 'dry-run' };
  }

  const { data } = await api.post('/renders', payload);

  // Creatomate returns an array of render objects
  const render = Array.isArray(data) ? data[0] : data;
  return render;
}

/**
 * Poll for render completion (Creatomate renders async).
 */
async function pollRender(renderId, maxWaitMs = 300000) {
  const start = Date.now();
  const pollInterval = 5000;

  while (Date.now() - start < maxWaitMs) {
    const { data } = await api.get(`/renders/${renderId}`);
    const status = data.status;

    if (status === 'succeeded') {
      return data;
    }
    if (status === 'failed') {
      throw new Error(`Render failed: ${data.error_message || 'unknown error'}`);
    }

    // Still rendering — wait and retry
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`Render timed out after ${maxWaitMs / 1000}s`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const prospects = getProspects();

  if (prospects.length === 0) {
    console.log('No prospects with creatomate videos in "prompted" status.');
    console.log('Use: node src/video/prompt-generator.js --tool creatomate');
    return;
  }

  console.log(`Rendering ${prospects.length} videos via Creatomate${args['dry-run'] ? ' (DRY RUN)' : ''}...\n`);

  const updateVideo = db.prepare(`
    UPDATE videos SET status = ?, video_url = ? WHERE id = ?
  `);

  let success = 0;
  let failed = 0;

  for (const prospect of prospects) {
    try {
      console.log(`[${prospect.id}] ${prospect.business_name} (${prospect.city})...`);

      // Submit render
      const render = await submitRender(prospect);

      if (args['dry-run']) {
        success++;
        continue;
      }

      console.log(`  Render submitted (${render.id}), waiting for completion`);
      updateVideo.run('rendering', null, prospect.video_id);

      // Poll for completion
      const completed = await pollRender(render.id);
      const videoUrl = completed.url;

      console.log(`\n  ✓ Video ready: ${videoUrl}`);
      updateVideo.run('completed', videoUrl, prospect.video_id);

      // Update prospect status
      db.prepare(
        'UPDATE prospects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run('video_created', prospect.id);

      success++;
    } catch (err) {
      console.error(`\n  ✗ Failed: ${err.message}`);
      updateVideo.run('failed', null, prospect.video_id);
      failed++;
    }
  }

  db.close();
  console.log(`\nDone: ${success} rendered, ${failed} failed`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
