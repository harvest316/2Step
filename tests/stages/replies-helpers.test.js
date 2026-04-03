/**
 * Unit tests for pure helper functions exported from replies.js.
 *
 * The replies stage primarily delegates to 333Method's autoresponder, so
 * the main testable pure logic is the pricing resolution function
 * getTwoStepPricing, which queries the shared msgs.pricing table first
 * and falls back to hardcoded defaults when no DB row is found.
 *
 * In the test environment, the msgs.pricing table may or may not be
 * populated — tests focus on the return shape, the fallback path (for
 * unknown country codes), and consistency guarantees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTwoStepPricing, runRepliesStage } from '../../src/stages/replies.js';

// ─── getTwoStepPricing — return shape ────────────────────────────────────────

describe('getTwoStepPricing — return shape', () => {
  it('returns an object with amount, currency, and symbol keys for AU', async () => {
    const result = await getTwoStepPricing('AU');
    assert.ok(typeof result === 'object');
    assert.ok('amount' in result);
    assert.ok('currency' in result);
    assert.ok('symbol' in result);
  });

  it('returns an object with amount, currency, and symbol keys for US', async () => {
    const result = await getTwoStepPricing('US');
    assert.ok('amount' in result);
    assert.ok('currency' in result);
    assert.ok('symbol' in result);
  });

  it('returns an object with amount, currency, and symbol keys for UK', async () => {
    const result = await getTwoStepPricing('UK');
    assert.ok('amount' in result);
    assert.ok('currency' in result);
    assert.ok('symbol' in result);
  });

  it('returns an object with amount, currency, and symbol keys for GB', async () => {
    const result = await getTwoStepPricing('GB');
    assert.ok('amount' in result);
    assert.ok('currency' in result);
    assert.ok('symbol' in result);
  });
});

// ─── getTwoStepPricing — type guarantees ─────────────────────────────────────

describe('getTwoStepPricing — type guarantees', () => {
  it('returns numeric amount for all known countries', async () => {
    for (const cc of ['AU', 'US', 'UK', 'GB']) {
      const result = await getTwoStepPricing(cc);
      assert.equal(typeof result.amount, 'number', `${cc}: amount should be a number`);
    }
  });

  it('returns string currency for all known countries', async () => {
    for (const cc of ['AU', 'US', 'UK', 'GB']) {
      const result = await getTwoStepPricing(cc);
      assert.equal(typeof result.currency, 'string', `${cc}: currency should be a string`);
    }
  });

  it('returns string symbol for all known countries', async () => {
    for (const cc of ['AU', 'US', 'UK', 'GB']) {
      const result = await getTwoStepPricing(cc);
      assert.equal(typeof result.symbol, 'string', `${cc}: symbol should be a string`);
      assert.ok(result.symbol.length >= 1, `${cc}: symbol should be non-empty`);
    }
  });

  it('all amounts are positive', async () => {
    for (const cc of ['AU', 'US', 'UK', 'GB']) {
      const result = await getTwoStepPricing(cc);
      assert.ok(result.amount > 0, `${cc}: amount should be positive, got ${result.amount}`);
    }
  });
});

// ─── getTwoStepPricing — currency mapping ────────────────────────────────────

describe('getTwoStepPricing — currency mapping', () => {
  it('AU returns AUD currency', async () => {
    const result = await getTwoStepPricing('AU');
    assert.equal(result.currency, 'AUD');
    assert.equal(result.symbol, '$');
  });

  it('US returns USD currency', async () => {
    const result = await getTwoStepPricing('US');
    assert.equal(result.currency, 'USD');
    assert.equal(result.symbol, '$');
  });

  it('UK returns GBP currency', async () => {
    const result = await getTwoStepPricing('UK');
    assert.equal(result.currency, 'GBP');
    assert.equal(result.symbol, '\u00a3');
  });

  it('GB returns GBP currency', async () => {
    const result = await getTwoStepPricing('GB');
    assert.equal(result.currency, 'GBP');
    assert.equal(result.symbol, '\u00a3');
  });
});

// ─── getTwoStepPricing — fallback to AU defaults for unknown ────────────────

describe('getTwoStepPricing — fallback for unknown country codes', () => {
  it('falls back to AUD for unknown country code', async () => {
    const result = await getTwoStepPricing('JP');
    assert.equal(result.currency, 'AUD');
    assert.equal(result.symbol, '$');
    assert.equal(result.amount, 625);
  });

  it('falls back to AUD for empty string country code', async () => {
    const result = await getTwoStepPricing('');
    assert.equal(result.currency, 'AUD');
    assert.equal(result.amount, 625);
  });

  it('falls back to AUD for null country code', async () => {
    const result = await getTwoStepPricing(null);
    assert.equal(result.currency, 'AUD');
    assert.equal(result.amount, 625);
  });

  it('falls back to AUD for undefined country code', async () => {
    const result = await getTwoStepPricing(undefined);
    assert.equal(result.currency, 'AUD');
    assert.equal(result.amount, 625);
  });

  it('falls back to AUD for numeric country code', async () => {
    const result = await getTwoStepPricing('99');
    assert.equal(result.currency, 'AUD');
    assert.equal(result.amount, 625);
  });

  it('falls back to AUD for lowercase country code', async () => {
    // The DB query uses the raw country code, which may not match
    // if the DB only has uppercase entries — falls back to hardcoded
    const result = await getTwoStepPricing('zz');
    assert.equal(result.currency, 'AUD');
    assert.equal(result.amount, 625);
  });
});

// ─── getTwoStepPricing — consistency ─────────────────────────────────────────

describe('getTwoStepPricing — consistency', () => {
  it('returns same result on repeated calls for AU', async () => {
    const r1 = await getTwoStepPricing('AU');
    const r2 = await getTwoStepPricing('AU');
    assert.deepEqual(r1, r2);
  });

  it('returns same result on repeated calls for US', async () => {
    const r1 = await getTwoStepPricing('US');
    const r2 = await getTwoStepPricing('US');
    assert.deepEqual(r1, r2);
  });

  it('returns same result on repeated calls for unknown', async () => {
    const r1 = await getTwoStepPricing('ZZ');
    const r2 = await getTwoStepPricing('ZZ');
    assert.deepEqual(r1, r2);
  });

  it('AU pricing is in a reasonable range ($300-$1500)', async () => {
    const result = await getTwoStepPricing('AU');
    assert.ok(result.amount >= 300 && result.amount <= 1500,
      `AU amount ${result.amount} outside expected range`);
  });

  it('US pricing is in a reasonable range ($200-$1200)', async () => {
    const result = await getTwoStepPricing('US');
    assert.ok(result.amount >= 200 && result.amount <= 1200,
      `US amount ${result.amount} outside expected range`);
  });

  it('UK pricing is in a reasonable range (100-800 GBP)', async () => {
    const result = await getTwoStepPricing('UK');
    assert.ok(result.amount >= 100 && result.amount <= 800,
      `UK amount ${result.amount} outside expected range`);
  });
});

// ─── runRepliesStage export ──────────────────────────────────────────────────

describe('runRepliesStage export', () => {
  it('exports a runRepliesStage function', () => {
    assert.equal(typeof runRepliesStage, 'function');
  });
});
