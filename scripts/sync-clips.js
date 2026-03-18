#!/usr/bin/env node
/**
 * Clip sync — keeps three stores in sync:
 *   R2 (source of truth) → B2 (backup) → local clips/ (render cache)
 *
 * Usage:
 *   node scripts/sync-clips.js            # R2 → B2 (backup new clips)
 *   node scripts/sync-clips.js --warm     # R2 → local clips/ (pre-warm cache)
 *   node scripts/sync-clips.js --all      # R2 → B2 + local clips/
 *   node scripts/sync-clips.js --list     # List R2 clips and B2/local status
 *
 * Credentials from .env:
 *   R2: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BUCKET_NAME, R2_PUBLIC_URL
 *   B2: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_BUCKET_ID
 */

import '../src/utils/load-env.js';
import { writeFile, mkdir, access, readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = resolve(__dirname, '../clips');

const {
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BUCKET_NAME, R2_PUBLIC_URL,
  B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_BUCKET_ID,
} = process.env;

const { values: args } = parseArgs({
  options: {
    warm:  { type: 'boolean', default: false },
    all:   { type: 'boolean', default: false },
    list:  { type: 'boolean', default: false },
  },
  strict: false,
});

// ── R2 ────────────────────────────────────────────────────────────────────────

/**
 * List all .mp4 objects in the R2 clips bucket.
 * Returns [{ key, size, etag }]
 */
async function listR2Clips() {
  // CF API defaults to 20 objects — must pass per_page=1000 to get all
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects?per_page=1000`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`R2 list failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const objects = json.result || [];
  return objects
    .filter(o => o.key.endsWith('.mp4') && !o.key.startsWith('video-') && !o.key.startsWith('poster-'))
    .map(o => ({ key: o.key, size: o.size, etag: o.etag }));
}

async function downloadR2Clip(key, destPath) {
  const url = `${R2_PUBLIC_URL}/${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`R2 download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return buf;
}

// ── B2 ────────────────────────────────────────────────────────────────────────

let b2Auth = null;

async function b2Authorize() {
  if (b2Auth) return b2Auth;
  const creds = Buffer.from(`${B2_KEY_ID}:${B2_APPLICATION_KEY}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${creds}` },
  });
  if (!res.ok) throw new Error(`B2 auth failed ${res.status}: ${await res.text()}`);
  b2Auth = await res.json();
  return b2Auth;
}

async function b2GetUploadUrl() {
  const auth = await b2Authorize();
  const res = await fetch(`${auth.apiInfo.storageApi.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bucketId: B2_BUCKET_ID }),
  });
  if (!res.ok) throw new Error(`B2 get_upload_url failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * List all .mp4 files already in B2.
 * Returns Set of filenames (keys).
 */
async function listB2Clips() {
  const auth = await b2Authorize();
  const existing = new Set();
  let startFileName = null;

  while (true) {
    const body = {
      bucketId: B2_BUCKET_ID,
      maxFileCount: 1000,
      prefix: '',
    };
    if (startFileName) body.startFileName = startFileName;

    const res = await fetch(`${auth.apiInfo.storageApi.apiUrl}/b2api/v3/b2_list_file_names`, {
      method: 'POST',
      headers: {
        Authorization: auth.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`B2 list failed ${res.status}: ${await res.text()}`);
    const json = await res.json();
    for (const f of json.files || []) {
      if (f.fileName.endsWith('.mp4')) existing.add(f.fileName);
    }
    if (!json.nextFileName) break;
    startFileName = json.nextFileName;
  }

  return existing;
}

async function uploadToB2(filename, buf, retries = 3) {
  const sha1 = createHash('sha1').update(buf).digest('hex');
  for (let attempt = 1; attempt <= retries; attempt++) {
    // Get a fresh upload URL each attempt (503s invalidate the previous one)
    b2Auth = null; // force re-auth on retry to get fresh upload URL
    const uploadInfo = await b2GetUploadUrl();
    const res = await fetch(uploadInfo.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: uploadInfo.authorizationToken,
        'X-Bz-File-Name': encodeURIComponent(filename),
        'Content-Type': 'video/mp4',
        'Content-Length': String(buf.length),
        'X-Bz-Content-Sha1': sha1,
      },
      body: buf,
    });
    if (res.ok) return res.json();
    const body = await res.text();
    if (attempt < retries && (res.status === 503 || res.status === 500)) {
      process.stdout.write(` (B2 ${res.status}, retry ${attempt})...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`B2 upload failed ${res.status}: ${body}`);
  }
}

// ── Local cache ───────────────────────────────────────────────────────────────

async function isLocalCached(filename) {
  try {
    await access(join(CLIPS_DIR, filename));
    return true;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const doB2   = args.all || (!args.warm && !args.list);
  const doWarm = args.all || args.warm;
  const doList = args.list;

  console.log('Listing R2 clips...');
  const r2Clips = await listR2Clips();
  console.log(`  ${r2Clips.length} clips in R2\n`);

  let b2Existing = new Set();
  if (doB2 || doList) {
    process.stdout.write('Listing B2 clips...');
    b2Existing = await listB2Clips();
    process.stdout.write(` ${b2Existing.size} already backed up\n\n`);
  }

  if (doList) {
    await mkdir(CLIPS_DIR, { recursive: true });
    console.log('Clip status (R2 = source, B2 = backup, local = cache):\n');
    console.log(`${'Filename'.padEnd(50)} ${'R2'.padEnd(6)} ${'B2'.padEnd(6)} Local`);
    console.log('─'.repeat(72));
    for (const { key, size } of r2Clips) {
      const inB2    = b2Existing.has(key) ? '✓' : '✗';
      const inLocal = (await isLocalCached(key)) ? '✓' : '✗';
      const kb = Math.round(size / 1024);
      console.log(`${key.padEnd(50)} ${'✓'.padEnd(6)} ${inB2.padEnd(6)} ${inLocal}  (${kb}KB)`);
    }
    return;
  }

  await mkdir(CLIPS_DIR, { recursive: true });

  let b2Done = 0, b2Skip = 0, warmDone = 0, warmSkip = 0;

  for (const { key, size } of r2Clips) {
    const needsB2    = doB2   && !b2Existing.has(key);
    const needsLocal = doWarm && !(await isLocalCached(key));

    if (!needsB2 && !needsLocal) {
      if (doB2)   b2Skip++;
      if (doWarm) warmSkip++;
      continue;
    }

    const kb = Math.round(size / 1024);
    process.stdout.write(`  ${key} (${kb}KB)...`);

    // Download from R2 once; reuse buffer for B2 upload and/or local write
    let buf = null;

    if (needsLocal) {
      const localPath = join(CLIPS_DIR, key);
      buf = await downloadR2Clip(key, localPath);
      process.stdout.write(' cached');
      warmDone++;
    }

    if (needsB2) {
      if (!buf) {
        // Need buf for B2 upload but didn't download for local — fetch into memory
        const res = await fetch(`${R2_PUBLIC_URL}/${key}`);
        if (!res.ok) throw new Error(`R2 download failed ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      }
      await uploadToB2(key, buf);
      process.stdout.write(' → B2');
      b2Done++;
    }

    process.stdout.write('\n');
  }

  console.log('\nDone.');
  if (doB2)   console.log(`  B2:    ${b2Done} uploaded, ${b2Skip} already present`);
  if (doWarm) console.log(`  Local: ${warmDone} cached, ${warmSkip} already present`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
