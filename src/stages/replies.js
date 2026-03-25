#!/usr/bin/env node

/**
 * Replies pipeline stage for 2Step.
 *
 * Processes unread inbound messages from msgs.messages where project='2step',
 * classifies intent, generates an LLM reply, and (optionally) sends it.
 *
 * Delegates to 333Method's autoresponder.processInboundQueue() with 2Step-specific
 * config injected: messagesTable, db connection, pricing, and project label.
 *
 * Usage:
 *   node src/stages/replies.js             # Process all pending inbound messages
 *   node src/stages/replies.js --limit 5   # Process up to 5
 *   node src/stages/replies.js --dry-run   # Classify without sending
 */

import '../utils/load-env.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import db from '../utils/db.js';
import { processInboundQueue } from '../../../333Method/src/inbound/autoresponder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 2Step pricing ────────────────────────────────────────────────────────────

/**
 * Resolve 2Step-specific pricing from msgs.pricing, falling back to
 * hardcoded defaults if the table has no rows for this project.
 *
 * The autoresponder's buildContext() calls this function with a country code
 * and expects { amount, currency, symbol } back.
 *
 * @param {string} countryCode
 * @returns {{ amount: number, currency: string, symbol: string }}
 */
function getTwoStepPricing(countryCode) {
  // Query the shared pricing table for the current active row for 2step
  try {
    const row = db
      .prepare(
        `SELECT setup_local, monthly_8, currency
         FROM msgs.pricing
         WHERE project = '2step'
           AND country_code = ?
           AND superseded_at IS NULL
         ORDER BY effective_from DESC
         LIMIT 1`
      )
      .get(countryCode);

    if (row) {
      const symbols = { AUD: '$', USD: '$', GBP: '\u00a3', CAD: '$', NZD: '$' };
      return {
        amount: row.setup_local || row.monthly_8 || 625,
        currency: row.currency,
        symbol: symbols[row.currency] || '$',
      };
    }
  } catch (_) {
    // msgs.pricing not available — fall back to hardcoded defaults below
  }

  // Hardcoded defaults (from 2Step CLAUDE.md: $625 setup + $99/month)
  const defaults = {
    AU: { amount: 625, currency: 'AUD', symbol: '$' },
    US: { amount: 597, currency: 'USD', symbol: '$' },
    UK: { amount: 497, currency: 'GBP', symbol: '\u00a3' },
    GB: { amount: 497, currency: 'GBP', symbol: '\u00a3' },
  };
  return defaults[countryCode] || defaults.AU;
}

// ── Stage runner ─────────────────────────────────────────────────────────────

/* c8 ignore start — external autoresponder delegation + DB I/O */
/**
 * Run the 2Step replies stage — classify and auto-respond to inbound messages.
 *
 * @param {Object} [options]
 * @param {number}  [options.limit]         - Not used by processInboundQueue; kept for API consistency
 * @param {boolean} [options.dryRun=false]  - When true, disable autoresponder sends
 * @returns {Promise<{ processed: number, replied: number, errors: number }>}
 */
export async function runRepliesStage(options = {}) {
  const { dryRun = false } = options;

  console.log(
    `[replies] Starting 2Step replies stage${dryRun ? ' (DRY RUN — autoresponder disabled)' : ''}`
  );

  // Temporarily disable autoresponder sends when dry-run is requested
  const prevAutoresponderEnv = process.env.AUTORESPONDER_ENABLED;
  if (dryRun) {
    process.env.AUTORESPONDER_ENABLED = 'false';
  }

  let result;
  try {
    result = await processInboundQueue({
      db,
      messagesTable: 'msgs.messages',
      pricing: getTwoStepPricing,
      project: '2step',
    });
  } finally {
    // Restore env var whether we succeeded or threw
    if (dryRun) {
      if (prevAutoresponderEnv === undefined) {
        delete process.env.AUTORESPONDER_ENABLED;
      } else {
        process.env.AUTORESPONDER_ENABLED = prevAutoresponderEnv;
      }
    }
  }

  const stats = {
    processed: result.processed,
    replied: result.sent,
    errors: result.failed,
  };

  console.log(
    `[replies] Stage complete: ${stats.processed} processed, ` +
    `${stats.replied} replied, ${stats.errors} errors`
  );

  return stats;
}

/* c8 ignore stop */

// ── Test-visible exports for pure helper functions ───────────────────────

export { getTwoStepPricing };

// ── CLI entry point ──────────────────────────────────────────────────────────

/* c8 ignore start — CLI entry point */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });

  runRepliesStage({ dryRun: args['dry-run'] })
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
