#!/usr/bin/env node

/**
 * Google Sheets sync for 2Step — push prospect data to a master sheet.
 *
 * Uses the same service account credentials as 333Method.
 * 21-column layout matching the master briefing's Google Sheet schema.
 *
 * Usage:
 *   node src/sheets/sync.js push     # Push all prospects to sheet
 *   node src/sheets/sync.js pull     # Pull status updates from sheet
 */

import '../utils/load-env.js';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DB_PATH = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const SHEET_ID = process.env.TWOSTEP_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n');

const command = process.argv[2] || 'push';

if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error('Missing Google Sheets config. Ensure TWOSTEP_SHEET_ID, GOOGLE_SHEETS_CLIENT_EMAIL, GOOGLE_SHEETS_PRIVATE_KEY are set.');
  process.exit(1);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function getSheets() {
  const auth = new google.auth.JWT(CLIENT_EMAIL, null, PRIVATE_KEY, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  return google.sheets({ version: 'v4', auth });
}

// ─── Column Layout (21 columns) ─────────────────────────────────────────────

const HEADERS = [
  'ID', 'Business Name', 'Owner First Name', 'Niche', 'City', 'State',
  'Country', 'Google Rating', 'Review Count', 'Best Review',
  'Phone', 'Email', 'Instagram', 'Facebook', 'Website',
  'Video Tool', 'Video URL', 'Video Status',
  'Outreach Channel', 'Outreach Status', 'Status',
];

// ─── Push ────────────────────────────────────────────────────────────────────

async function push() {
  const db = new Database(DB_PATH, { readonly: true });
  const sheets = await getSheets();

  const prospects = db.prepare(`
    SELECT p.*,
      v.video_tool, v.video_url, v.status as video_status,
      o.channel as outreach_channel, o.delivery_status as outreach_status
    FROM prospects p
    LEFT JOIN videos v ON v.prospect_id = p.id
    LEFT JOIN outreaches o ON o.prospect_id = p.id
    ORDER BY p.id ASC
  `).all();

  db.close();

  if (prospects.length === 0) {
    console.log('No prospects to push.');
    return;
  }

  const rows = prospects.map(p => [
    p.id,
    p.business_name,
    p.owner_first_name || '',
    p.niche || '',
    p.city || '',
    p.state || '',
    p.country_code || 'AU',
    p.google_rating || '',
    p.review_count || '',
    (p.best_review_text || '').substring(0, 200),
    p.phone || '',
    p.email || '',
    p.instagram_handle || '',
    p.facebook_page_url || '',
    p.website_url || '',
    p.video_tool || '',
    p.video_url || '',
    p.video_status || '',
    p.outreach_channel || '',
    p.outreach_status || '',
    p.status,
  ]);

  // Clear existing data and write fresh
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [HEADERS, ...rows],
    },
  });

  console.log(`Pushed ${rows.length} prospects to Google Sheet.`);
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}`);
}

// ─── Pull ────────────────────────────────────────────────────────────────────

async function pull() {
  const sheets = await getSheets();

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A2:U',
  });

  const rows = data.values || [];
  if (rows.length === 0) {
    console.log('No data in sheet.');
    return;
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const updateStatus = db.prepare(`
    UPDATE prospects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);

  const updateVideoUrl = db.prepare(`
    UPDATE videos SET video_url = ?, status = 'completed' WHERE prospect_id = ? AND video_url IS NULL
  `);

  let updated = 0;
  for (const row of rows) {
    const id = parseInt(row[0], 10);
    if (!id) continue;

    const videoUrl = row[16]; // Column Q: Video URL
    const status = row[20];   // Column U: Status

    if (videoUrl) {
      const result = updateVideoUrl.run(videoUrl, id);
      if (result.changes > 0) {
        console.log(`  Updated video URL for prospect #${id}`);
        updated++;
      }
    }

    if (status) {
      updateStatus.run(status, id);
    }
  }

  db.close();
  console.log(`Pulled updates: ${updated} changes from ${rows.length} rows.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (command === 'push') {
  push().catch(err => { console.error('Push failed:', err.message); process.exit(1); });
} else if (command === 'pull') {
  pull().catch(err => { console.error('Pull failed:', err.message); process.exit(1); });
} else {
  console.error(`Unknown command: ${command}. Use 'push' or 'pull'.`);
  process.exit(1);
}
