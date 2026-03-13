#!/usr/bin/env node

/**
 * Backup local clips/ to Backblaze B2 (private bucket).
 *
 * Uses the native B2 API (no AWS SDK needed):
 *   1. b2_authorize_account  → get apiUrl + authToken
 *   2. b2_get_upload_url     → per-bucket upload endpoint (re-fetched on 503)
 *   3. b2_upload_file        → PUT with SHA-1 header
 *
 * Required env vars:
 *   B2_KEY_ID            Application key ID
 *   B2_APPLICATION_KEY   Application key secret
 *   B2_BUCKET_ID         Bucket ID (not name)
 *   B2_BUCKET_NAME       Bucket name (display only)
 *
 * Usage:
 *   node src/video/r2-backup.js           # upload all local clips
 *   node src/video/r2-backup.js --dry-run
 */

import '../utils/load-env.js';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_ROOT = resolve(__dirname, '../../clips');

const KEY_ID    = process.env.B2_KEY_ID;
const APP_KEY   = process.env.B2_APPLICATION_KEY;
const BUCKET_ID = process.env.B2_BUCKET_ID;
const BUCKET_NAME = process.env.B2_BUCKET_NAME || 'B2';

const { values: args } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
  strict: false,
});

if (!KEY_ID || !APP_KEY || !BUCKET_ID) {
  console.error('ERROR: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID must be set');
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

async function authorize() {
  const creds = Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${creds}` },
  });
  if (!res.ok) throw new Error(`b2_authorize_account failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { apiUrl: data.apiUrl, authToken: data.authorizationToken };
}

async function getUploadUrl(apiUrl, authToken) {
  const res = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url?bucketId=${BUCKET_ID}`, {
    headers: { Authorization: authToken },
  });
  if (!res.ok) throw new Error(`b2_get_upload_url failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { uploadUrl: data.uploadUrl, uploadAuthToken: data.authorizationToken };
}

async function uploadFile(uploadUrl, uploadAuthToken, localPath, fileName) {
  const body = readFileSync(localPath);
  const sha1 = createHash('sha1').update(body).digest('hex');
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: uploadAuthToken,
      'X-Bz-File-Name': encodeURIComponent(fileName),
      'Content-Type': 'video/mp4',
      'Content-Length': body.length,
      'X-Bz-Content-Sha1': sha1,
    },
    body,
  });
  if (res.status === 503 || res.status === 408 || res.status === 429) {
    // Upload URL expired or server busy — caller should refresh
    throw Object.assign(new Error(`transient ${res.status}`), { transient: true });
  }
  if (!res.ok) throw new Error(`upload failed ${res.status}: ${(await res.text()).substring(0, 200)}`);
  return await res.json();
}

async function main() {
  const files = findMp4s(CLIPS_ROOT);
  console.log(`\nFound ${files.length} clips to back up to B2 bucket "${BUCKET_NAME}"\n`);

  if (args['dry-run']) {
    for (const f of files) console.log(' ', f.replace(CLIPS_ROOT + '/', ''));
    return;
  }

  console.log('Authorizing with Backblaze B2...');
  const { apiUrl, authToken } = await authorize();
  let { uploadUrl, uploadAuthToken } = await getUploadUrl(apiUrl, authToken);

  let ok = 0, fail = 0;
  for (const localPath of files) {
    const fileName = localPath.split('/').pop(); // flat key, same as R2
    const size = (statSync(localPath).size / 1024 / 1024).toFixed(1);
    process.stdout.write(`  ${fileName} (${size}MB)...`);
    try {
      // Refresh upload URL on transient errors
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await uploadFile(uploadUrl, uploadAuthToken, localPath, fileName);
          break;
        } catch (err) {
          if (err.transient && attempt < 2) {
            ({ uploadUrl, uploadAuthToken } = await getUploadUrl(apiUrl, authToken));
            continue;
          }
          throw err;
        }
      }
      console.log(' ✓');
      ok++;
    } catch (err) {
      console.log(` ✗  ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${ok} backed up, ${fail} failed\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
