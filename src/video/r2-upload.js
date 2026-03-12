#!/usr/bin/env node

/**
 * Upload local clips/ to Cloudflare R2 for public hosting.
 *
 * Uses the Cloudflare API (Bearer token) to PUT objects directly.
 * R2 public URL base: R2_PUBLIC_URL env var.
 *
 * Usage:
 *   node src/video/r2-upload.js           # upload all clips
 *   node src/video/r2-upload.js --dry-run # list what would be uploaded
 */

import '../utils/load-env.js';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_ROOT = resolve(__dirname, '../../clips');

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET      = process.env.R2_BUCKET_NAME;
const PUBLIC_URL  = process.env.R2_PUBLIC_URL;

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  strict: false,
});

if (!ACCOUNT_ID || !API_TOKEN || !BUCKET) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BUCKET_NAME must be set');
  process.exit(1);
}

function findMp4s(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMp4s(full));
    else if (entry.name.endsWith('.mp4')) results.push(full);
  }
  return results;
}

async function upload(localPath, key) {
  const body = readFileSync(localPath);
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'video/mp4',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed ${res.status}: ${text.substring(0, 200)}`);
  }
  return `${PUBLIC_URL}/${key}`;
}

async function main() {
  const files = findMp4s(CLIPS_ROOT);
  console.log(`\nFound ${files.length} clips to upload to R2 bucket "${BUCKET}"\n`);

  if (args['dry-run']) {
    for (const f of files) console.log(' ', f.replace(CLIPS_ROOT + '/', ''));
    return;
  }

  let ok = 0, fail = 0;
  for (const localPath of files) {
    // Key = just the filename (flat, no subdirs) for clean public URLs
    const key = localPath.split('/').pop();
    const size = (statSync(localPath).size / 1024 / 1024).toFixed(1);
    process.stdout.write(`  ${key} (${size}MB)...`);
    try {
      const publicUrl = await upload(localPath, key);
      console.log(` ✓  ${publicUrl}`);
      ok++;
    } catch (err) {
      console.log(` ✗  ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${ok} uploaded, ${fail} failed\n`);
  if (ok > 0) console.log(`Public URL base: ${PUBLIC_URL}/<filename.mp4>`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
