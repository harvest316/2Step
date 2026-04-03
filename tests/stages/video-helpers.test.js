/**
 * Unit tests for pure helper functions exported from video.js.
 *
 * Tests the toBase62 function which converts integers to base62 strings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toBase62, buildPosterFromBuffer, processSite, runVideoStage } from '../../src/stages/video.js';
import sharp from 'sharp';

// ─── toBase62 ────────────────────────────────────────────────────────────────

describe('toBase62', () => {
  const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

  it('converts 0 to the first base62 character', () => {
    assert.equal(toBase62(0), '0');
  });

  it('converts 1 to "1"', () => {
    assert.equal(toBase62(1), '1');
  });

  it('converts 9 to "9"', () => {
    assert.equal(toBase62(9), '9');
  });

  it('converts 10 to "A" (uppercase letters start at 10)', () => {
    assert.equal(toBase62(10), 'A');
  });

  it('converts 35 to "Z" (last uppercase letter)', () => {
    assert.equal(toBase62(35), 'Z');
  });

  it('converts 36 to "a" (lowercase letters start at 36)', () => {
    assert.equal(toBase62(36), 'a');
  });

  it('converts 61 to "z" (last base62 digit)', () => {
    assert.equal(toBase62(61), 'z');
  });

  it('converts 62 to "10" (first two-digit base62 number)', () => {
    assert.equal(toBase62(62), '10');
  });

  it('converts 63 to "11"', () => {
    assert.equal(toBase62(63), '11');
  });

  it('converts 124 to "20" (62*2)', () => {
    assert.equal(toBase62(124), '20');
  });

  it('converts 3844 to "100" (62^2)', () => {
    assert.equal(toBase62(3844), '100');
  });

  it('produces unique results for sequential site IDs', () => {
    const results = new Set();
    for (let i = 0; i < 200; i++) {
      results.add(toBase62(i));
    }
    assert.equal(results.size, 200, 'All 200 values should be unique');
  });

  it('result contains only valid base62 characters', () => {
    const validChars = new Set(BASE62_CHARS.split(''));
    for (const testVal of [0, 1, 42, 100, 999, 12345, 999999]) {
      const result = toBase62(testVal);
      for (const ch of result) {
        assert.ok(validChars.has(ch), `Invalid char '${ch}' in toBase62(${testVal}) = "${result}"`);
      }
    }
  });

  it('returns a string', () => {
    assert.equal(typeof toBase62(42), 'string');
  });

  it('handles typical site IDs (small numbers)', () => {
    // Site IDs in 2Step are small (1-100 range currently)
    // BASE62_CHARS: 0-9 = digits, 10-35 = A-Z, 36-61 = a-z
    assert.equal(toBase62(1), '1');
    assert.equal(toBase62(15), 'F');  // 15 -> uppercase index 5 -> 'F'
    assert.equal(toBase62(50), 'o');  // 50 -> lowercase index 14 -> 'o'
  });

  it('handles larger IDs (hundreds)', () => {
    // 100 = 1*62 + 38 => '1' + base62[38] = '1c'
    const result = toBase62(100);
    assert.equal(result.length, 2);
  });

  it('handles very large numbers', () => {
    const result = toBase62(1000000);
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
    // Verify it's reasonable length: log62(1000000) ~ 3.5 => 4 chars
    assert.ok(result.length <= 5, `Expected <= 5 chars for 1000000, got ${result.length}`);
  });

  it('is consistent across multiple calls', () => {
    assert.equal(toBase62(42), toBase62(42));
    assert.equal(toBase62(999), toBase62(999));
  });
});

// ─── buildPosterFromBuffer ──────────────────────────────────────────────────

/**
 * Helper: create a minimal solid-colour PNG buffer of given dimensions.
 */
async function makeTestImage(width, height, color = { r: 200, g: 100, b: 50 }) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer();
}

describe('buildPosterFromBuffer', () => {
  it('returns a Buffer', async () => {
    const input = await makeTestImage(400, 300);
    const result = await buildPosterFromBuffer(input);
    assert.ok(Buffer.isBuffer(result));
  });

  it('returns a JPEG image', async () => {
    const input = await makeTestImage(400, 300);
    const result = await buildPosterFromBuffer(input);
    // JPEG magic bytes: FF D8 FF
    assert.equal(result[0], 0xFF);
    assert.equal(result[1], 0xD8);
    assert.equal(result[2], 0xFF);
  });

  it('resizes to 561px wide', async () => {
    const input = await makeTestImage(1200, 800);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 561);
  });

  it('maintains aspect ratio when resizing', async () => {
    const input = await makeTestImage(1200, 800);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    // 1200:800 = 3:2, so 561px wide => ~374px tall
    const expectedHeight = Math.round(561 * (800 / 1200));
    // Allow 1px tolerance due to rounding
    assert.ok(
      Math.abs(meta.height - expectedHeight) <= 2,
      `Expected height ~${expectedHeight}, got ${meta.height}`
    );
  });

  it('handles small images (upscales to 561px)', async () => {
    const input = await makeTestImage(200, 150);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 561);
  });

  it('handles square images', async () => {
    const input = await makeTestImage(500, 500);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 561);
    // Square should remain square-ish
    assert.ok(
      Math.abs(meta.width - meta.height) <= 2,
      `Expected square-ish, got ${meta.width}x${meta.height}`
    );
  });

  it('handles tall portrait images', async () => {
    const input = await makeTestImage(300, 600);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 561);
  });

  it('handles exactly 561px wide images', async () => {
    const input = await makeTestImage(561, 316);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 561);
  });

  it('output is a valid JPEG that sharp can read', async () => {
    const input = await makeTestImage(800, 600);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.format, 'jpeg');
  });

  it('output has 3 channels (RGB, no alpha)', async () => {
    const input = await makeTestImage(400, 300);
    const result = await buildPosterFromBuffer(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.channels, 3);
  });

  it('output size is reasonable (compressed JPEG)', async () => {
    const input = await makeTestImage(800, 600);
    const result = await buildPosterFromBuffer(input);
    // A 561px JPEG with play button overlay should be under 200KB
    assert.ok(result.length < 200_000, `JPEG too large: ${result.length} bytes`);
    // And at least a few KB (not empty/corrupt)
    assert.ok(result.length > 1000, `JPEG too small: ${result.length} bytes`);
  });
});

// ─── processSite (dry-run mode) ──────────────────────────────────────────────
// Exercises the parsing, prospect-building, scene-building, clip-picking,
// music/variant selection code paths without any network I/O.

function makeSite(overrides = {}) {
  return {
    id: 1,
    business_name: 'Test Pest Control',
    city: 'Sydney',
    niche: 'pest control',
    problem_category: 'cockroaches',
    phone: '+61400000000',
    logo_url: 'https://cdn.example.com/logo.png',
    selected_review_json: JSON.stringify({
      text: 'Had a terrible cockroach infestation in our kitchen and they came out the same day to inspect and treat everything professionally and thoroughly from start to finish.',
      author: 'John Smith',
      rating: 5,
    }),
    best_review_text: null,
    best_review_author: null,
    google_rating: 4.8,
    country_code: 'AU',
    ...overrides,
  };
}

describe('processSite — dry-run mode', () => {
  it('returns null for dry-run', async () => {
    const result = await processSite(makeSite(), { dryRun: true });
    assert.equal(result, null);
  });

  it('does not throw for valid site data', async () => {
    await assert.doesNotReject(() => processSite(makeSite(), { dryRun: true }));
  });

  it('parses selected_review_json correctly', async () => {
    // Should not throw when selected_review_json is valid JSON
    const result = await processSite(makeSite(), { dryRun: true });
    assert.equal(result, null);
  });

  it('throws for invalid selected_review_json', async () => {
    const site = makeSite({ selected_review_json: 'not valid json' });
    await assert.rejects(
      () => processSite(site, { dryRun: true }),
      /not valid JSON/
    );
  });

  it('throws when no review text is available', async () => {
    const site = makeSite({
      selected_review_json: JSON.stringify({ text: '', author: 'John', rating: 5 }),
      best_review_text: '',
    });
    await assert.rejects(
      () => processSite(site, { dryRun: true }),
      /No review text available/
    );
  });

  it('falls back to best_review_text when selected_review_json has no text', async () => {
    const site = makeSite({
      selected_review_json: JSON.stringify({ author: 'John', rating: 5 }),
      best_review_text: 'Great service from the team, they handled everything professionally and we are very impressed.',
    });
    // Should not throw — falls back to best_review_text
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('falls back to best_review_author when review JSON has no author', async () => {
    const site = makeSite({
      selected_review_json: JSON.stringify({
        text: 'Amazing cockroach treatment service, they handled everything very professionally and thoroughly from top to bottom.',
      }),
      best_review_author: 'Jane Doe',
    });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('works with null selected_review_json and populated best_review_text', async () => {
    const site = makeSite({
      selected_review_json: null,
      best_review_text: 'Excellent cockroach treatment, they handled the infestation quickly and professionally from start to finish throughout the whole property.',
      best_review_author: 'Customer Name',
    });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('defaults city to Sydney when not set', async () => {
    const site = makeSite({ city: null });
    // Should not throw
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('defaults niche to pest control when not set', async () => {
    const site = makeSite({ niche: null });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('uses problem_category for clip pool when available', async () => {
    const site = makeSite({ problem_category: 'cockroaches' });
    // Should not throw — cockroaches should exist in clip pool
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('falls back to niche for clip pool when problem_category is null', async () => {
    // niche defaults to "pest control" which has no direct pool,
    // but plumber does — so test with plumber niche
    const site = makeSite({ problem_category: null, niche: 'plumber' });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('throws when no clips are available for the category', async () => {
    const site = makeSite({ problem_category: 'nonexistent_category_xyz', niche: 'nonexistent_niche_xyz' });
    await assert.rejects(
      () => processSite(site, { dryRun: true }),
      /No clips available/
    );
  });

  it('handles different site IDs deterministically', async () => {
    // Run with different IDs — both should succeed (dry-run returns null)
    const result1 = await processSite(makeSite({ id: 1 }), { dryRun: true });
    const result2 = await processSite(makeSite({ id: 2 }), { dryRun: true });
    assert.equal(result1, null);
    assert.equal(result2, null);
  });

  it('handles review with author_name field (alternative key)', async () => {
    const site = makeSite({
      selected_review_json: JSON.stringify({
        text: 'Great cockroach treatment, very thorough and professional service from start to finish throughout the entire property.',
        author_name: 'Alternative Author',
        rating: 5,
      }),
    });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('handles review with review_text field (alternative key)', async () => {
    const site = makeSite({
      selected_review_json: JSON.stringify({
        review_text: 'Great cockroach treatment, very thorough and professional service from start to finish throughout the entire property.',
        author: 'John',
        rating: 5,
      }),
    });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });

  it('defaults google_rating to 5 when not in review or site', async () => {
    const site = makeSite({
      google_rating: null,
      selected_review_json: JSON.stringify({
        text: 'Great cockroach treatment from this amazing team, thoroughly impressed with their professional service throughout.',
        author: 'John',
      }),
    });
    const result = await processSite(site, { dryRun: true });
    assert.equal(result, null);
  });
});

// ─── runVideoStage ──────────────────────────────────────────────────────────

describe('runVideoStage', () => {
  it('exports a function', () => {
    assert.equal(typeof runVideoStage, 'function');
  });

  it('returns stats object with expected keys', async () => {
    // dryRun to avoid hitting ElevenLabs/ffmpeg in CI
    const stats = await runVideoStage({ dryRun: true });
    assert.ok(typeof stats === 'object');
    assert.ok('processed' in stats);
    assert.ok('created' in stats);
    assert.ok('errors' in stats);
    // created + errors must account for all processed sites
    assert.equal(stats.created + stats.errors, stats.processed);
  });

  it('accepts limit option', async () => {
    const stats = await runVideoStage({ limit: 1, dryRun: true });
    assert.ok(stats.processed <= 1);
    assert.equal(stats.created + stats.errors, stats.processed);
  });

  it('accepts dryRun option — created + errors equals processed', async () => {
    const stats = await runVideoStage({ dryRun: true });
    assert.equal(stats.created + stats.errors, stats.processed);
  });

  it('accepts siteId option for non-existent site', async () => {
    const stats = await runVideoStage({ siteId: 999999 });
    assert.equal(stats.processed, 0);
  });

  it('accepts localOnly option', async () => {
    const stats = await runVideoStage({ localOnly: true, dryRun: true });
    assert.equal(stats.created + stats.errors, stats.processed);
  });

  it('returns numbers for all stats fields', async () => {
    const stats = await runVideoStage({ dryRun: true });
    assert.equal(typeof stats.processed, 'number');
    assert.equal(typeof stats.created, 'number');
    assert.equal(typeof stats.errors, 'number');
  });
});
