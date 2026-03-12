#!/usr/bin/env node

/**
 * Check Kling AI credit balance via the /v1/account/costs endpoint.
 *
 * Returns resource pack info including remaining_quantity.
 * Note: Kling updates balances with a ~12 hour delay, so this may lag slightly.
 *
 * Usage:
 *   node src/video/kling-balance.js
 */

import '../utils/load-env.js';
import { createHmac } from 'crypto';

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const KLING_API_BASE   = 'https://api.klingai.com/v1';

if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
  console.error('ERROR: KLING_ACCESS_KEY and KLING_SECRET_KEY must be set in .env');
  process.exit(1);
}

function klingJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 })).toString('base64url');
  const sig = createHmac('sha256', KLING_SECRET_KEY).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function getBalance() {
  // Query the last 90 days to capture all active packs.
  // Note: Kling's /account/costs endpoint is documented but appears undeployed in production
  // (returns 404 even with valid auth). We try it anyway and fall back gracefully.
  const end   = Date.now();
  const start = end - 90 * 24 * 60 * 60 * 1000;

  const url = `${KLING_API_BASE}/account/costs?start_time=${start}&end_time=${end}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${klingJwt()}` },
  });

  if (res.status === 404) {
    console.log('⚠️  Balance endpoint not available (Kling API returned 404).');
    console.log('   Check balance manually at: https://klingai.com/global/dev/console');
    console.log('   The /v1/account/costs endpoint is documented but not yet deployed.');
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`balance check failed ${res.status}: ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  if (data.code !== 0) throw new Error(`API error: ${data.message}`);

  const packs = data.data?.resource_pack_subscribe_infos ?? [];
  if (!packs.length) {
    console.log('No resource packs found (or balance endpoint not yet returning data).');
    console.log('Check manually: https://klingai.com/global/dev/console');
    return;
  }

  let totalRemaining = 0;
  for (const p of packs) {
    const status = p.status === 'online' ? '✓ active' : `✗ ${p.status}`;
    const pct = p.total_quantity > 0
      ? Math.round((p.remaining_quantity / p.total_quantity) * 100)
      : 0;
    const expires = new Date(p.invalid_time).toLocaleDateString('en-AU');
    console.log(`  [${status}] ${p.resource_pack_name}`);
    console.log(`    Remaining: ${p.remaining_quantity} / ${p.total_quantity} (${pct}%)  — expires ${expires}`);
    if (p.status === 'online') totalRemaining += p.remaining_quantity;
  }

  console.log(`\nTotal active credits: ${totalRemaining}`);
  console.log('(Note: Kling updates balances with ~12h delay)');
}

getBalance().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
