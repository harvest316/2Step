#!/usr/bin/env node

/**
 * Back up all R2 clips to Backblaze B2 using the native B2 API.
 *
 * Flow: authorize → get upload URL → upload each missing clip (streamed from R2).
 * Skips files already present by listing the bucket first.
 *
 * Usage:
 *   node src/video/b2-backup.js            # upload all missing clips
 *   node src/video/b2-backup.js --dry-run  # show what would be uploaded
 */

import '../utils/load-env.js';
import { createHash } from 'crypto';
import { parseArgs } from 'util';
import { CLIP_POOLS } from './shotstack-lib.js';

const KEY_ID   = process.env.B2_KEY_ID;
const APP_KEY  = process.env.B2_APPLICATION_KEY;
const BUCKET   = process.env.B2_BUCKET_NAME;
const BUCKET_ID = process.env.B2_BUCKET_ID;

if (!KEY_ID || !APP_KEY || !BUCKET || !BUCKET_ID) {
  console.error('ERROR: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_BUCKET_ID must be set');
  process.exit(1);
}

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  strict: false,
});

// ─── B2 native API auth ───────────────────────────────────────────────────────

async function authorize() {
  const credentials = Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`B2 authorize failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    apiUrl:        data.apiInfo.storageApi.apiUrl,
    authToken:     data.authorizationToken,
    downloadUrl:   data.apiInfo.storageApi.downloadUrl,
  };
}

// ─── List files in bucket (handles pagination) ────────────────────────────────

async function listAllFiles(apiUrl, authToken) {
  const existing = new Set();
  let startFileName = null;

  while (true) {
    const body = JSON.stringify({
      bucketId: BUCKET_ID,
      maxFileCount: 1000,
      ...(startFileName ? { startFileName } : {}),
    });
    const res = await fetch(`${apiUrl}/b2api/v3/b2_list_file_names`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`B2 list failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const f of data.files) existing.add(f.fileName);
    if (!data.nextFileName) break;
    startFileName = data.nextFileName;
  }

  return existing;
}

// ─── Get upload URL (refreshed per session) ───────────────────────────────────

async function getUploadUrl(apiUrl, authToken) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: BUCKET_ID }),
  });
  if (!res.ok) throw new Error(`B2 get_upload_url failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { uploadUrl: data.uploadUrl, uploadAuthToken: data.authorizationToken };
}

// ─── Upload one clip from R2 URL ──────────────────────────────────────────────

async function uploadFromUrl(filename, sourceUrl, uploadUrl, uploadAuthToken) {
  const srcRes = await fetch(sourceUrl);
  if (!srcRes.ok) throw new Error(`R2 fetch failed ${srcRes.status}`);
  const body = Buffer.from(await srcRes.arrayBuffer());
  const sha1 = createHash('sha1').update(body).digest('hex');

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization:      uploadAuthToken,
      'X-Bz-File-Name':  encodeURIComponent(filename),
      'Content-Type':     'video/mp4',
      'Content-Length':   String(body.length),
      'X-Bz-Content-Sha1': sha1,
    },
    body,
  });
  if (!res.ok) throw new Error(`B2 upload failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (body.length / 1024 / 1024).toFixed(1);
}

// ─── Collect all unique clips from CLIP_POOLS ────────────────────────────────

function collectClips() {
  const seen = new Set();
  const results = [];
  for (const pool of Object.values(CLIP_POOLS)) {
    for (const clips of Object.values(pool)) {
      for (const clip of clips) {
        const filename = clip.url.split('/').pop();
        if (!seen.has(filename)) {
          seen.add(filename);
          results.push({ filename, url: clip.url });
        }
      }
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const clips = collectClips();
  console.log(`\n${clips.length} clips in CLIP_POOLS`);

  console.log('Authorising with B2...');
  const { apiUrl, authToken } = await authorize();

  console.log('Checking B2 for existing files...');
  const existing = await listAllFiles(apiUrl, authToken);
  console.log(`${existing.size} already in B2\n`);

  const missing = clips.filter(c => !existing.has(c.filename));

  if (missing.length === 0) {
    console.log('B2 is fully in sync — nothing to upload.');
    return;
  }

  console.log(`${missing.length} clips to upload:\n`);

  if (args['dry-run']) {
    for (const { filename } of missing) console.log(`  ${filename}`);
    return;
  }

  let { uploadUrl, uploadAuthToken } = await getUploadUrl(apiUrl, authToken);

  let ok = 0, fail = 0;
  for (const { filename, url } of missing) {
    process.stdout.write(`  ${filename}...`);
    try {
      const mb = await uploadFromUrl(filename, url, uploadUrl, uploadAuthToken);
      console.log(` ${mb}MB ✓`);
      ok++;
    } catch (err) {
      console.log(` ✗  ${err.message}`);
      // Re-fetch upload URL on failure (token may have expired)
      try {
        ({ uploadUrl, uploadAuthToken } = await getUploadUrl(apiUrl, authToken));
      } catch (_) {}
      fail++;
    }
  }

  console.log(`\n${ok} uploaded, ${fail} failed`);
  if (ok > 0) console.log(`B2 bucket: ${BUCKET}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
