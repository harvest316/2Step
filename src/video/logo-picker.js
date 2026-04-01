#!/usr/bin/env node

/**
 * CV-based logo picker using Claude CLI (Max subscription).
 *
 * Given a business name and a list of candidate logo image paths,
 * asks Claude vision to pick the best one (preferably with brand name visible).
 *
 * Uses `claude -p` with Read tool access so Claude can view the images
 * via its built-in multimodal capabilities.
 *
 * Usage:
 *   import { pickBestLogo } from './logo-picker.js';
 *   const best = await pickBestLogo('Emerald Cleaning', ['/tmp/logo1.png', '/tmp/logo2.png']);
 *   // → { index: 0, path: '/tmp/logo1.png', reasoning: '...' }
 *
 *   CLI: node src/video/logo-picker.js --business "Emerald Cleaning" --images /tmp/logo1.png /tmp/logo2.png
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';
import sharp from 'sharp';

/**
 * Downsize an image to reduce CV token cost while keeping it readable.
 * Max 200x200px, JPEG quality 80.
 * @param {string} imagePath - Path to original image
 * @param {string} outPath - Path to write downsized image
 * @returns {Promise<string>} outPath
 */
export async function downsizeForVision(imagePath, outPath) {
  await sharp(imagePath)
    .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(outPath);
  return outPath;
}

/**
 * Pick the best logo from a list of candidate image paths using Claude CLI vision.
 *
 * @param {string} businessName - The business name to match against
 * @param {string[]} imagePaths - Absolute paths to candidate logo images
 * @param {Object} [opts]
 * @param {string} [opts.model] - Claude model (default: sonnet)
 * @param {boolean} [opts.downsize] - Downsize images first (default: true)
 * @returns {Promise<{ index: number, path: string, reasoning: string } | null>}
 */
export async function pickBestLogo(businessName, imagePaths, opts = {}) {
  const { model = 'sonnet', downsize = true } = opts;

  // Filter to existing files
  const validPaths = imagePaths.filter(p => existsSync(p));
  if (validPaths.length === 0) return null;
  if (validPaths.length === 1) {
    return { index: 0, path: validPaths[0], reasoning: 'Only one candidate' };
  }

  // Downsize for cost efficiency
  let evalPaths = validPaths;
  if (downsize) {
    const { mkdirSync } = await import('fs');
    const tmpDir = '/tmp/logo-picker';
    mkdirSync(tmpDir, { recursive: true });
    evalPaths = await Promise.all(
      validPaths.map(async (p, i) => {
        const out = `${tmpDir}/candidate-${i}.jpg`;
        await downsizeForVision(p, out);
        return out;
      })
    );
  }

  // Build prompt — Claude CLI's Read tool will view each image
  const fileList = evalPaths.map((p, i) => `  ${i + 1}. ${p}`).join('\n');
  const prompt = `You are evaluating logo candidates for the business "${businessName}".

I need you to look at each of these images and pick the best logo. Read each file to view it:

${fileList}

Criteria (in order of importance):
1. Must be an actual business logo (not a generic icon, stock photo, or unrelated image)
2. Prefer logos that show the business/brand name as readable text
3. Prefer vector-quality or clean PNG logos over blurry/tiny images
4. If none are actual logos, say "none"

Reply with ONLY a JSON object (no markdown fencing):
{"pick": <1-based number or 0 for none>, "reasoning": "<one sentence>"}`;

  try {
    const result = execFileSync('claude', [
      '-p',
      '--model', model,
      '--output-format', 'text',
      '--allowedTools', 'Read',
    ], {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();

    // Parse JSON from response (may have markdown fencing)
    const jsonMatch = result.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      console.error(`[logo-picker] Could not parse response: ${result.substring(0, 200)}`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const pick = parseInt(parsed.pick, 10);

    if (pick === 0 || isNaN(pick) || pick > validPaths.length) {
      return { index: -1, path: null, reasoning: parsed.reasoning || 'No suitable logo found' };
    }

    return {
      index: pick - 1,
      path: validPaths[pick - 1],
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    console.error(`[logo-picker] Claude CLI failed: ${err.message}`);
    return null;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isMain) {
  const { values: args, positionals } = parseArgs({
    options: {
      business: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      'no-downsize': { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  // Image paths are positional args (everything after named flags)
  const images = positionals.filter(p => !p.startsWith('-'));

  if (!args.business || !images.length) {
    console.error('Usage: node logo-picker.js --business "Name" /path/1.png /path/2.png');
    process.exit(1);
  }

  const result = await pickBestLogo(args.business, images, {
    model: args.model,
    downsize: !args['no-downsize'],
  });

  if (result) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('No result');
    process.exit(1);
  }
}
