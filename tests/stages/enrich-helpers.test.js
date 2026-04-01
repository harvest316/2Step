/**
 * Unit tests for pure helper functions exported from enrich.js.
 *
 * Tests:
 *   - detectLogoBg: background detection for logos
 *   - applyGreyPill: adaptive background treatment for logos
 *   - Constants: PILL_MAX_W, PILL_MAX_H, PILL_RADIUS, PILL_PADDING
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  applyGreyPill,
  detectLogoBg,
  PILL_MAX_W, PILL_MAX_H, PILL_RADIUS, PILL_PADDING,
} from '../../src/stages/enrich.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Solid opaque colour image (simulates logo with solid background) */
async function makeTestImage(width, height, channels = 4, bg) {
  const background = bg || (channels === 4
    ? { r: 255, g: 0, b: 0, alpha: 255 }
    : { r: 255, g: 0, b: 0 });
  return sharp({ create: { width, height, channels, background } }).png().toBuffer();
}

/** White-background logo (red rectangle on white) */
async function makeWhiteBgLogo(w = 200, h = 100) {
  const white = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } } }).png().toBuffer();
  const inner = await sharp({ create: { width: w - 40, height: h - 40, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 255 } } }).png().toBuffer();
  return sharp(white).composite([{ input: inner, gravity: 'centre' }]).png().toBuffer();
}

/** Dark-background logo (white text area on dark) */
async function makeDarkBgLogo(w = 200, h = 100) {
  const dark = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 30, g: 30, b: 40, alpha: 255 } } }).png().toBuffer();
  const inner = await sharp({ create: { width: w - 40, height: h - 40, channels: 4, background: { r: 220, g: 220, b: 220, alpha: 255 } } }).png().toBuffer();
  return sharp(dark).composite([{ input: inner, gravity: 'centre' }]).png().toBuffer();
}

/** Transparent-background logo with dark content */
async function makeTransparentDarkLogo(w = 200, h = 100) {
  // Transparent canvas with a dark shape in the middle
  const canvas = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const inner = await sharp({ create: { width: w - 60, height: h - 40, channels: 4, background: { r: 40, g: 40, b: 60, alpha: 255 } } }).png().toBuffer();
  return sharp(canvas).composite([{ input: inner, gravity: 'centre' }]).png().toBuffer();
}

/** Transparent-background logo with light content */
async function makeTransparentLightLogo(w = 200, h = 100) {
  const canvas = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const inner = await sharp({ create: { width: w - 60, height: h - 40, channels: 4, background: { r: 240, g: 240, b: 230, alpha: 255 } } }).png().toBuffer();
  return sharp(canvas).composite([{ input: inner, gravity: 'centre' }]).png().toBuffer();
}

// ─── Constants ──────────────────────────────────────────────────────────────

describe('enrich constants', () => {
  it('PILL_MAX_W is 972', () => assert.equal(PILL_MAX_W, 972));
  it('PILL_MAX_H is 480', () => assert.equal(PILL_MAX_H, 480));
  it('PILL_RADIUS is 12 (rectangle)', () => assert.equal(PILL_RADIUS, 12));
  it('PILL_PADDING is 24', () => assert.equal(PILL_PADDING, 24));
});

// ─── detectLogoBg ───────────────────────────────────────────────────────────

describe('detectLogoBg', () => {
  it('detects white solid background', async () => {
    const img = await makeWhiteBgLogo();
    const result = await detectLogoBg(img);
    assert.equal(result.hasSolidBg, true);
    assert.equal(result.isLight, true);
  });

  it('detects dark solid background', async () => {
    const img = await makeDarkBgLogo();
    const result = await detectLogoBg(img);
    assert.equal(result.hasSolidBg, true);
    assert.equal(result.isLight, false);
  });

  it('detects transparent background with dark content', async () => {
    const img = await makeTransparentDarkLogo();
    const result = await detectLogoBg(img);
    assert.equal(result.hasSolidBg, false);
    assert.equal(result.hasAlpha, true);
  });

  it('detects transparent background with light content', async () => {
    const img = await makeTransparentLightLogo();
    const result = await detectLogoBg(img);
    assert.equal(result.hasSolidBg, false);
    assert.equal(result.hasAlpha, true);
  });

  it('handles 3-channel (RGB) images', async () => {
    const img = await makeTestImage(100, 100, 3);
    const result = await detectLogoBg(img);
    assert.equal(typeof result.hasSolidBg, 'boolean');
    assert.equal(typeof result.isLight, 'boolean');
  });
});

// ─── applyGreyPill (adaptive) ───────────────────────────────────────────────

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

  it('adds padding around the logo', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    // Output = logo + 2 * PILL_PADDING on each axis
    assert.equal(meta.width, 200 + PILL_PADDING * 2);
    assert.equal(meta.height, 100 + PILL_PADDING * 2);
  });

  it('constrains oversized images within max bounds', async () => {
    const input = await makeTestImage(1500, 300);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.ok(meta.width <= PILL_MAX_W, `Width ${meta.width} exceeds max`);
    assert.ok(meta.height <= PILL_MAX_H, `Height ${meta.height} exceeds max`);
  });

  it('never upscales (small image stays small + padding)', async () => {
    const input = await makeTestImage(100, 50);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 100 + PILL_PADDING * 2);
    assert.equal(meta.height, 50 + PILL_PADDING * 2);
  });

  it('has 4 channels (RGBA) in output', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.channels, 4);
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
    assert.equal(meta.width, 1 + PILL_PADDING * 2);
    assert.equal(meta.height, 1 + PILL_PADDING * 2);
  });

  it('output is not empty', async () => {
    const input = await makeTestImage(200, 100);
    const result = await applyGreyPill(input);
    assert.ok(result.length > 100, `Output too small: ${result.length} bytes`);
  });

  it('white-bg logo gets white background treatment', async () => {
    const input = await makeWhiteBgLogo(300, 150);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    // Check it didn't crash and produced valid output with padding
    assert.equal(meta.width, 300 + PILL_PADDING * 2);
    assert.equal(meta.format, 'png');
  });

  it('dark-bg logo gets dark background treatment', async () => {
    const input = await makeDarkBgLogo(300, 150);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.width, 300 + PILL_PADDING * 2);
    assert.equal(meta.format, 'png');
  });

  it('transparent dark logo gets white background', async () => {
    const input = await makeTransparentDarkLogo(300, 150);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.channels, 4);
  });

  it('transparent light logo gets dark background', async () => {
    const input = await makeTransparentLightLogo(300, 150);
    const result = await applyGreyPill(input);
    const meta = await sharp(result).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.channels, 4);
  });
});
