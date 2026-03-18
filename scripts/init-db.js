#!/usr/bin/env node

/**
 * 2Step database initialisation and migration runner.
 *
 * Usage:
 *   node scripts/init-db.js
 *   DATABASE_PATH=/absolute/path/to/2step.db node scripts/init-db.js
 *   MESSAGES_DB_PATH=/absolute/path/to/messages.db node scripts/init-db.js
 *
 * What this does:
 *   1. Opens (or creates) 2step.db
 *   2. Creates schema_migrations tracking table
 *   3. Runs each migration in db/migrations/ in order (001, 002, ...)
 *   4. Skips migrations that have already been applied
 *   5. Migrations 006 + 007 are handled inline (require ATTACH to messages.db)
 *   6. Logs progress to stdout
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dbPath = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const messagesDbPath = process.env.MESSAGES_DB_PATH
  || resolve(root, '../mmo-platform/db/messages.db');
const migrationsDir = resolve(root, 'db/migrations');

console.log(`2Step DB:   ${dbPath}`);
console.log(`Messages DB: ${messagesDbPath}`);

// ---------------------------------------------------------------------------
// Open 2step.db
// ---------------------------------------------------------------------------
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Create schema_migrations tracking table
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    migration  TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE migration = ?');
const markApplied = db.prepare(
  'INSERT INTO schema_migrations (migration) VALUES (?)'
);

// ---------------------------------------------------------------------------
// Helper: check if a table exists in 2step.db
// ---------------------------------------------------------------------------
function tableExists(tableName) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName);
}

// ---------------------------------------------------------------------------
// ATTACH messages.db if it exists (needed for migrations 006/007)
// ---------------------------------------------------------------------------
let messagesAttached = false;
if (existsSync(messagesDbPath)) {
  db.exec(`ATTACH DATABASE '${messagesDbPath}' AS msgs`);
  messagesAttached = true;
  console.log('Attached messages.db as msgs');
} else {
  console.warn(
    `WARNING: messages.db not found at ${messagesDbPath}. ` +
    `Migrations 006+007 (data copy to shared DB) will be skipped. ` +
    `Run mmo-platform/scripts/init-messages-db.js first, then re-run this script.`
  );
}

// ---------------------------------------------------------------------------
// Read and sort migration files
// ---------------------------------------------------------------------------
const migrationFiles = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

// ---------------------------------------------------------------------------
// Run migrations
// ---------------------------------------------------------------------------
for (const file of migrationFiles) {
  const name = basename(file, '.sql');

  if (isApplied.get(name)) {
    console.log(`  SKIP  ${name} (already applied)`);
    continue;
  }

  // Migrations 006 and 007 are inline Node.js logic (require ATTACH)
  if (name.startsWith('006-')) {
    runMigration006(name);
    continue;
  }
  if (name.startsWith('007-')) {
    runMigration007(name);
    continue;
  }

  // Standard SQL migration
  const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
  try {
    db.exec(sql);
    markApplied.run(name);
    console.log(`  APPLY ${name}`);
  } catch (err) {
    console.error(`  ERROR in ${name}: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Migration 006: copy outreaches -> msgs.messages
// ---------------------------------------------------------------------------
function runMigration006(name) {
  if (!messagesAttached) {
    console.warn(`  SKIP  ${name} (messages.db not attached — run init-messages-db.js first)`);
    return;
  }
  if (!tableExists('outreaches')) {
    // Already dropped by migration 008, or was never present
    markApplied.run(name);
    console.log(`  SKIP  ${name} (outreaches table not found — already migrated)`);
    return;
  }

  console.log(`  APPLY ${name}`);

  // Map delivery_status values from outreaches -> messages schema
  // outreaches: pending | sent | delivered | failed | replied | bounced
  // messages:   queued  | sent | delivered | failed | n/a     | bounced
  const deliveryStatusMap = {
    pending:   'queued',
    sent:      'sent',
    delivered: 'delivered',
    failed:    'failed',
    replied:   'delivered', // replied = delivered + we got a reply; treat as delivered
    bounced:   'bounced',
  };

  const outreaches = db.prepare('SELECT * FROM outreaches').all();
  const insertMsg = db.prepare(`
    INSERT INTO msgs.messages
      (project, site_id, direction, contact_method, contact_uri,
       message_body, delivery_status, message_type, sent_at, created_at, updated_at)
    VALUES
      ('2step', ?, 'outbound', ?, ?, ?, ?, 'outreach', ?, ?, ?)
  `);

  const migrate = db.transaction(() => {
    let count = 0;
    for (const row of outreaches) {
      const mappedStatus = deliveryStatusMap[row.delivery_status] || 'queued';
      insertMsg.run(
        row.prospect_id,
        row.channel,
        row.contact_uri,
        row.message_body,
        mappedStatus,
        row.sent_at,
        row.created_at,
        row.created_at
      );
      count++;
    }
    return count;
  });

  const count = migrate();
  markApplied.run(name);
  console.log(`  APPLY ${name} — migrated ${count} outreach rows`);
}

// ---------------------------------------------------------------------------
// Migration 007: copy conversations -> msgs.messages
// ---------------------------------------------------------------------------
function runMigration007(name) {
  if (!messagesAttached) {
    console.warn(`  SKIP  ${name} (messages.db not attached — run init-messages-db.js first)`);
    return;
  }
  if (!tableExists('conversations')) {
    markApplied.run(name);
    console.log(`  SKIP  ${name} (conversations table not found — already migrated)`);
    return;
  }

  console.log(`  APPLY ${name}`);

  // Map intent values from conversations -> messages schema
  // conversations: interested | not_interested | question | opt_out | unknown
  // messages:      interested | not-interested  | inquiry  | opt-out | unknown
  const intentMap = {
    interested:     'interested',
    not_interested: 'not-interested',
    question:       'inquiry',
    opt_out:        'opt-out',
    unknown:        'unknown',
  };

  const conversations = db.prepare('SELECT * FROM conversations').all();
  const insertMsg = db.prepare(`
    INSERT INTO msgs.messages
      (project, site_id, direction, contact_method, contact_uri,
       message_body, intent, message_type, sent_at, created_at, updated_at)
    VALUES
      ('2step', ?, ?, ?, '', ?, ?, 'reply', ?, ?, ?)
  `);

  const migrate = db.transaction(() => {
    let count = 0;
    for (const row of conversations) {
      const mappedIntent = row.intent ? (intentMap[row.intent] || 'unknown') : null;
      insertMsg.run(
        row.prospect_id,
        row.direction,
        row.channel,
        row.message_body,
        mappedIntent,
        row.created_at,
        row.created_at,
        row.created_at
      );
      count++;
    }
    return count;
  });

  const count = migrate();
  markApplied.run(name);
  console.log(`  APPLY ${name} — migrated ${count} conversation rows`);
}

// ---------------------------------------------------------------------------
// Final verification
// ---------------------------------------------------------------------------
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map(t => t.name)
  .filter(n => !n.startsWith('sqlite_'));

console.log(`\nTables in 2step.db: ${tables.join(', ')}`);

const migrations = db
  .prepare('SELECT migration, applied_at FROM schema_migrations ORDER BY id')
  .all();
console.log(`\nApplied migrations (${migrations.length}):`);
for (const m of migrations) {
  console.log(`  ${m.migration}  (${m.applied_at})`);
}

db.close();
console.log('\n2Step DB initialised successfully.');
