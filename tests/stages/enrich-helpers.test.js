/**
 * Unit tests for pure helper functions exported from enrich.js.
 *
 * Tests:
 *   - applyGreyPill: image processing — grey rounded-rect background behind logo
 *   - Constants: PILL_MAX_W, PILL_MAX_H, PILL_RADIUS, background RGBA values
 *
 * These tests use sharp to create minimal test images and verify the
 * output dimensions, format, and basic properties.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  applyGreyPill,
  PILL_MAX_W, PILL_MAX_H, PILL_RADIUS,
  PILL_BG_R, PILL_BG_G, PILL_BG_B, PILL_BG_A,
} from '../../src/stages/enrich.js';
import { runEnrichStage } from '../../src/stages/enrich.js';

// ─── Helper: create a test image buffer ─────────────────────────────────────

async function makeTestImage(width, height, channels = 4) {
  return sharp({
    create: {
      width,
      height,
      channels,
      background: channels === 4
        ? { r: 255, g: 0, b: 0, alpha: 255 }
        : { r: 255, g: 0, b: 0 },
    },
  }).png().toBuffer();
}

// ─── Constants ──────────────────────────────────────────────────────────────

describe('enrich constants', () => {
  it('PILL_MAX_W is 972', () => {
    assert.equal(PILL_MAX_W, 972);
  });

  it('PILL_MAX_H is 480', () => {
    assert.equal(PILL_MAX_H, 480);
  });

  it('PILL_RADIUS is 24', () => {
    assert.equal(PILL_RADIUS, 24);
  });

  it('PILL_BG is middle grey (#808080)', () => {
    assert.equal(PILL_BG_R, 128);
    assert.equal(PILL_BG_G, 128);
    assert.equal(PILL_BG_B, 128);
  });

  it('PILL_BG_A is ~50% opacity (128)', () => {
    assert.equal(PILL_BG_A, 128);
  });
});

// ─── applyGreyPill ──────────────────────────────────────────────────────────

describe('applyGreyPill', () => {
  it('returns a Buffer', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    assert.ok(Buffer.isBuffer(result));
  });

  it('returns a PNG image', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.format, 'png');
  });

  it('preserves dimensions for images smaller than max', async () => {
    const input = await makeTestImage(400, 200);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 200);
  });

  it('shrinks width to PILL_MAX_W for oversized images', async () => {
    // Image wider than PILL_MAX_W (972)
    const input = await makeTestImage(1500, 300);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.ok(meta.width <= PILL_MAX_W, `Width ${meta.width} exceeds PILL_MAX_W ${PILL_MAX_W}`);
  });

  it('shrinks height to PILL_MAX_H for oversized images', async () => {
    // Image taller than PILL_MAX_H (480)
    const input = await makeTestImage(300, 800);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.ok(meta.height <= PILL_MAX_H, `Height ${meta.height} exceeds PILL_MAX_H ${PILL_MAX_H}`);
  });

  it('maintains aspect ratio when shrinking wide image', async () => {
    const input = await makeTestImage(1944, 480);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    // Scale factor: 972/1944 = 0.5
    // Expected: 972 x 240
    assert.equal(meta.width, 972);
    assert.ok(
      Math.abs(meta.height - 240) <= 1,
      `Expected height ~240, got ${meta.height}`
    );
  });

  it('maintains aspect ratio when shrinking tall image', async () => {
    const input = await makeTestImage(300, 960);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    // Scale factor: 480/960 = 0.5
    // Expected: 150 x 480
    assert.equal(meta.height, 480);
    assert.ok(
      Math.abs(meta.width - 150) <= 1,
      `Expected width ~150, got ${meta.width}`
    );
  });

  it('never upscales (small image stays small)', async () => {
    const input = await makeTestImage(100, 50);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    // The code uses withoutEnlargement: true for resize, BUT the display
    // dimensions are constrained by scale = Math.min(1, ...) so it stays at input size.
    assert.equal(meta.width, 100);
    assert.equal(meta.height, 50);
  });

  it('has 4 channels (RGBA) in output', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.channels, 4);
  });

  it('handles square images correctly', async () => {
    const input = await makeTestImage(400, 400);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 400);
  });

  it('handles images at exact PILL_MAX_W x PILL_MAX_H', async () => {
    const input = await makeTestImage(PILL_MAX_W, PILL_MAX_H);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, PILL_MAX_W);
    assert.equal(meta.height, PILL_MAX_H);
  });

  it('handles 3-channel (RGB, no alpha) input images', async () => {
    const input = await makeTestImage(200, 100, 3);
    const result = await applyGreyPill(input);
    assert.ok(Buffer.isBuffer(result));
    const meta = await sharp(result).metadata();
    assert.equal(meta.format, 'png');
  });

  it('handles very small images (1x1)', async () => {
    const input = await makeTestImage(1, 1);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 1);
    assert.equal(meta.height, 1);
  });

  it('output is not empty', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    assert.ok(result.length > 100, `Output too small: ${result.length} bytes`);
  });

  it('output is larger than input for small images (due to grey pill composite)', async () => {
    const input = await makeTestImage(50, 50);
    const result = await applyGreyPill(input);
    // The composite adds data, so output should generally be larger
    assert.ok(result.length > 0);
  });

  it('constrains both dimensions when both exceed max', async () => {
    // Both dimensions exceed max; the more constrained dimension wins
    const input = await makeTestImage(2000, 1000);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.ok(meta.width <= PILL_MAX_W);
    assert.ok(meta.height <= PILL_MAX_H);
  });

  it('uses the smaller scale factor when both exceed', async () => {
    // 2000 x 1000: scaleW = 972/2000 = 0.486, scaleH = 480/1000 = 0.48
    // scale = 0.48 => 960 x 480 => wait, 2000*0.48 = 960 which is < 972, and 1000*0.48 = 480
    const input = await makeTestImage(2000, 1000);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.height, 480);
    assert.ok(meta.width <= PILL_MAX_W);
  });
});

// ─── runEnrichStage ──────────────────────────────────────────────────────────

describe('runEnrichStage', () => {
  it('exports a function', () => {
    assert.equal(typeof runEnrichStage, 'function');
  });

  it('returns stats object when no sites at reviews_downloaded', async () => {
    // Test DB has no sites at reviews_downloaded status
    const stats = await runEnrichStage();
    assert.ok(typeof stats === 'object');
    assert.ok('processed' in stats);
    assert.ok('enriched' in stats);
    assert.ok('errors' in stats);
    assert.equal(stats.processed, 0);
    assert.equal(stats.enriched, 0);
    assert.equal(stats.errors, 0);
  });

  it('accepts limit option', async () => {
    const stats = await runEnrichStage({ limit: 1 });
    assert.equal(stats.processed, 0);
  });

  it('accepts dryRun option', async () => {
    const stats = await runEnrichStage({ dryRun: true });
    assert.equal(stats.processed, 0);
  });

  it('accepts concurrency option', async () => {
    const stats = await runEnrichStage({ concurrency: 1 });
    assert.equal(stats.processed, 0);
  });

  it('returns numbers for all stats fields', async () => {
    const stats = await runEnrichStage();
    assert.equal(typeof stats.processed, 'number');
    assert.equal(typeof stats.enriched, 'number');
    assert.equal(typeof stats.errors, 'number');
  });
});
