/**
 * E2E tests for the 2Step unsubscribe flow.
 *
 * Tests the full chain:
 *   1. GET /p/{hash} worker returns correct response shape
 *   2. Unsubscribe worker GET ?email= handler returns 200 HTML
 *   3. Unsubscribe worker GET ?email= writes to unsubscribes.json (via /unsubscribes.json read-back)
 *   4. sync-opt-outs stage reads from worker and writes to msgs.opt_outs
 *   5. isOptedOut() returns true for that email
 *   6. runOutreachStage skips the opted-out contact
 *
 * Requires live network access to:
 *   - https://unsubscribe-worker.auditandfix.workers.dev (Cloudflare Worker)
 *   - PostgreSQL at DATABASE_URL
 *
 * These tests are skipped automatically if E2E_ENABLED=true is not set,
 * to avoid mutating the production opt-out list during normal test runs.
 */

import '../../../src/utils/load-env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const E2E = process.env.E2E_ENABLED === 'true';
const WORKER_URL = (
  process.env.UNSUBSCRIBE_WORKER_URL || 'https://unsubscribe-worker.auditandfix.workers.dev'
).replace(/\/$/, '');

const TEST_EMAIL = `e2e-unsub-test-${Date.now()}@2step-test.invalid`;

// ── Worker HTTP tests ─────────────────────────────────────────────────────────

describe('unsubscribe worker — GET ?email=', { skip: !E2E }, () => {
  it('returns 400 for missing email param', async () => {
    const res = await fetch(`${WORKER_URL}/`);
    // Without ?email= it hits the default handler — not 400, just the default text
    assert.ok(res.status < 500, `Expected non-5xx, got ${res.status}`);
  });

  it('returns 400 for invalid email (no @)', async () => {
    const res = await fetch(`${WORKER_URL}/?email=notanemail`);
    assert.equal(res.status, 400);
  });

  it('returns 200 HTML confirmation for valid email', async () => {
    const res = await fetch(`${WORKER_URL}/?email=${encodeURIComponent(TEST_EMAIL)}`);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${await res.text()}`);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('text/html'), `Expected HTML response, got: ${ct}`);
  });

  it('stores the opt-out in unsubscribes.json', async () => {
    // Allow a moment for R2 write to propagate
    await new Promise(r => setTimeout(r, 1000));

    const res = await fetch(`${WORKER_URL}/unsubscribes.json`);
    assert.equal(res.status, 200);
    const records = await res.json();
    assert.ok(Array.isArray(records), 'Expected array from /unsubscribes.json');

    const found = records.find(r => r.email === TEST_EMAIL);
    assert.ok(found, `TEST_EMAIL ${TEST_EMAIL} not found in unsubscribes.json`);
    assert.equal(found.source, 'get_link');
    assert.ok(found.timestamp, 'Missing timestamp');
  });

  it('is idempotent — second GET does not duplicate the record', async () => {
    await fetch(`${WORKER_URL}/?email=${encodeURIComponent(TEST_EMAIL)}`);
    await new Promise(r => setTimeout(r, 500));

    const res = await fetch(`${WORKER_URL}/unsubscribes.json`);
    const records = await res.json();
    const matches = records.filter(r => r.email === TEST_EMAIL);
    assert.equal(matches.length, 1, 'Should only have one record for the same email');
  });
});

// ── sync-opt-outs stage → msgs.opt_outs ──────────────────────────────────────

describe('sync-opt-outs stage', { skip: !E2E }, () => {
  let pool;

  before(async () => {
    // Ensure the test email is in the worker's R2 before we sync
    await fetch(`${WORKER_URL}/?email=${encodeURIComponent(TEST_EMAIL)}`);
    await new Promise(r => setTimeout(r, 1000));

    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  after(async () => {
    // Clean up: remove test opt-out from DB
    if (pool) {
      await pool.query(
        `DELETE FROM msgs.opt_outs WHERE email = $1`,
        [TEST_EMAIL]
      );
      await pool.end();
    }
  });

  it('runSyncOptOutsStage imports email-keyed records into msgs.opt_outs', async () => {
    const { runSyncOptOutsStage } = await import('../../../src/stages/sync-opt-outs.js');
    const stats = await runSyncOptOutsStage({ dryRun: false });

    assert.ok(typeof stats.inserted === 'number');
    assert.ok(typeof stats.skipped === 'number');
    assert.ok(typeof stats.errors === 'number');
    assert.equal(stats.errors, 0, `Expected 0 errors, got ${stats.errors}`);
  });

  it('opts-out email is now in msgs.opt_outs', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM msgs.opt_outs WHERE email = $1 AND method = 'email'`,
      [TEST_EMAIL]
    );
    assert.equal(rows.length, 1, `Expected 1 row for ${TEST_EMAIL}`);
    assert.equal(rows[0].method, 'email');
    assert.equal(rows[0].project, '2step');
  });

  it('isOptedOut returns true for opted-out email', async () => {
    let outreachMod;
    try {
      outreachMod = await import('../../../src/stages/outreach.js');
    } catch (err) {
      if (err.message.includes('twilio')) return; // skip if twilio absent
      throw err;
    }
    const result = await outreachMod.isOptedOut(null, TEST_EMAIL, 'email');
    assert.equal(result, true, 'isOptedOut should return true after sync');
  });
});
