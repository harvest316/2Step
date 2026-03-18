#!/usr/bin/env node

/**
 * 2Step pipeline service — continuous stage runner.
 *
 * Runs all pipeline stages in sequence on a timer. Each stage failure is caught
 * and logged; the remaining stages still run. On shutdown (SIGINT/SIGTERM) the
 * current iteration completes before exit.
 *
 * Stages (in order):
 *   1. reviews   — fetch/download Google reviews for new prospects
 *   2. enrich    — contact extraction + logo treatment
 *   3. video     — AI video generation
 *   4. proposals — draft outreach messages
 *   5. outreach  — send approved emails + SMS
 *   6. replies   — classify and auto-respond to inbound messages
 *
 * Usage:
 *   node src/stages/pipeline-service.js              # Continuous loop (default 60s interval)
 *   node src/stages/pipeline-service.js --once       # One iteration then exit
 *   node src/stages/pipeline-service.js --interval 120000  # Custom interval (ms)
 *
 * Environment:
 *   PIPELINE_INTERVAL_MS  — loop interval in milliseconds (default: 60000)
 */

import '../utils/load-env.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

// Stage imports — each module exports a `run*Stage(options)` function.
// Missing or stub stages are handled gracefully at runtime.
import { runEnrichStage } from './enrich.js';
import { runOutreachStage } from './outreach.js';
import { runRepliesStage } from './replies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy imports for stages that may not exist yet — wrapped in async helpers
// so a missing file throws at call time rather than import time.

async function safeImport(specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    return null;
  }
}

async function runReviewsStage(options = {}) {
  const mod = await safeImport('./reviews.js');
  if (!mod) {
    console.log('[pipeline] reviews.js not found — skipping reviews stage');
    return { skipped: true };
  }
  return mod.runReviewsStage(options);
}

async function runVideoStage(options = {}) {
  const mod = await safeImport('./video.js');
  if (!mod) {
    console.log('[pipeline] video.js not found — skipping video stage');
    return { skipped: true };
  }
  return mod.runVideoStage(options);
}

async function runProposalsStage(options = {}) {
  const mod = await safeImport('./proposals.js');
  if (!mod) {
    console.log('[pipeline] proposals.js not found — skipping proposals stage');
    return { skipped: true };
  }
  return mod.runProposalsStage(options);
}

// ── Shutdown handling ────────────────────────────────────────────────────────

let shuttingDown = false;

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[pipeline] Received ${signal} — finishing current iteration then exiting...`);
}

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

// ── One pipeline iteration ───────────────────────────────────────────────────

/**
 * Run one complete pass of all pipeline stages.
 *
 * @returns {Promise<Object>} Summary of results keyed by stage name
 */
async function runIteration() {
  const startedAt = Date.now();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n[pipeline] ===== Iteration started at ${ts} =====`);

  const summary = {};

  const stages = [
    { name: 'reviews',   fn: runReviewsStage },
    { name: 'enrich',    fn: runEnrichStage },
    { name: 'video',     fn: runVideoStage },
    { name: 'proposals', fn: runProposalsStage },
    { name: 'outreach',  fn: runOutreachStage },
    { name: 'replies',   fn: runRepliesStage },
  ];

  for (const { name, fn } of stages) {
    if (shuttingDown) {
      console.log(`[pipeline] Shutdown requested — skipping remaining stages`);
      break;
    }

    const stageStart = Date.now();
    try {
      console.log(`[pipeline] Running stage: ${name}`);
      const result = await fn();
      const elapsed = ((Date.now() - stageStart) / 1000).toFixed(1);
      console.log(`[pipeline] Stage ${name} complete in ${elapsed}s:`, result);
      summary[name] = { ok: true, result, elapsed: parseFloat(elapsed) };
    } catch (err) {
      const elapsed = ((Date.now() - stageStart) / 1000).toFixed(1);
      console.error(`[pipeline] Stage ${name} threw after ${elapsed}s: ${err.message}`);
      summary[name] = { ok: false, error: err.message, elapsed: parseFloat(elapsed) };
      // Continue to next stage
    }
  }

  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[pipeline] ===== Iteration complete in ${totalElapsed}s =====`);

  return summary;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const { values: args } = parseArgs({
    options: {
      once:     { type: 'boolean', default: false },
      interval: { type: 'string' },
    },
    strict: false,
  });

  const runOnce = args.once;
  const intervalMs = args.interval
    ? parseInt(args.interval, 10)
    : parseInt(process.env.PIPELINE_INTERVAL_MS || '60000', 10);

  if (runOnce) {
    console.log('[pipeline] Running one iteration (--once)');
    await runIteration();
    console.log('[pipeline] Done.');
    process.exit(0);
    return;
  }

  console.log(`[pipeline] Starting continuous loop (interval=${intervalMs}ms)`);
  console.log('[pipeline] Press Ctrl+C to stop after the current iteration');

  while (!shuttingDown) {
    await runIteration();

    if (shuttingDown) break;

    console.log(`[pipeline] Sleeping ${intervalMs}ms...`);

    // Sleep in small chunks so we can respond to shutdown quickly
    const chunkMs = 1000;
    let slept = 0;
    while (slept < intervalMs && !shuttingDown) {
      await new Promise(r => setTimeout(r, Math.min(chunkMs, intervalMs - slept)));
      slept += chunkMs;
    }
  }

  console.log('[pipeline] Exiting cleanly.');
  process.exit(0);
}

main().catch(err => {
  console.error('[pipeline] Fatal error:', err.message);
  process.exit(1);
});
