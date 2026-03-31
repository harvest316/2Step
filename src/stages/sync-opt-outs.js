#!/usr/bin/env node

/**
 * sync-opt-outs — 2Step pipeline stage.
 *
 * Polls the Cloudflare unsubscribe worker's R2 store for email-keyed opt-out
 * records (written by the GET ?email= handler) and inserts them into
 * msgs.opt_outs in PostgreSQL so outreach.js can suppress future sends.
 *
 * The R2 unsubscribes.json contains a mix of:
 *   - Old 333Method records: { outreachId, timestamp }
 *   - New 2Step records:     { email, source, timestamp }
 *
 * We only process records that have an `email` field.
 *
 * Usage:
 *   node src/stages/sync-opt-outs.js
 *   node src/stages/sync-opt-outs.js --dry-run
 */

import '../utils/load-env.js';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { parseArgs } from 'util';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const UNSUBSCRIBE_WORKER_URL = (
  process.env.UNSUBSCRIBE_WORKER_URL || 'https://unsubscribe-worker.auditandfix.workers.dev'
).replace(/\/$/, '');

export async function runSyncOptOutsStage({ dryRun = false } = {}) {
  // Fetch unsubscribes.json from the worker's R2
  const url = `${UNSUBSCRIBE_WORKER_URL}/unsubscribes.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch unsubscribes.json: ${res.status}`);

  let records;
  try {
    records = await res.json();
  } catch {
    throw new Error('unsubscribes.json is not valid JSON');
  }

  if (!Array.isArray(records)) {
    throw new Error(`Expected array, got ${typeof records}`);
  }

  // Only process email-keyed records (2Step format)
  const emailRecords = records.filter(r => r.email && r.email.includes('@'));

  console.log(`[sync-opt-outs] ${records.length} total records, ${emailRecords.length} email-keyed${dryRun ? ' (dry-run)' : ''}`);

  let inserted = 0, skipped = 0, errors = 0;

  for (const record of emailRecords) {
    const email = record.email.toLowerCase().trim();

    if (dryRun) {
      console.log(`  [dry] would opt-out ${email}`);
      inserted++;
      continue;
    }

    try {
      const result = await pool.query(
        `INSERT INTO msgs.opt_outs (email, method, source, project)
         VALUES ($1, 'email', 'unsubscribe_link', '2step')
         ON CONFLICT (email, method) DO NOTHING`,
        [email]
      );
      if (result.rowCount > 0) {
        console.log(`  opted out: ${email}`);
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  error for ${email}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[sync-opt-outs] done: ${inserted} inserted, ${skipped} already present, ${errors} errors`);
  return { inserted, skipped, errors };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { values: args } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  runSyncOptOutsStage({ dryRun: args['dry-run'] })
    .then(() => pool.end())
    .catch(err => {
      console.error(`Fatal: ${err.message}`);
      pool.end().finally(() => process.exit(1));
    });
}
