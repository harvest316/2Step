/**
 * 2Step database connection module.
 *
 * Opens 2step.db and ATTACHes mmo-platform/db/messages.db as `msgs`.
 * All message queries use the `msgs.` schema prefix:
 *   INSERT INTO msgs.messages (project, site_id, ...) VALUES ('2step', ?, ...)
 *   SELECT * FROM msgs.messages WHERE project='2step' AND site_id=?
 *
 * Environment variables:
 *   DATABASE_PATH    — absolute path to 2step.db (default: ../../db/2step.db)
 *   MESSAGES_DB_PATH — absolute path to messages.db (default: ../../../mmo-platform/db/messages.db)
 *
 * Production: always set MESSAGES_DB_PATH to an absolute path in .env and
 * systemd unit. The relative default is a dev fallback only.
 * SQLite ATTACH on a non-existent path silently creates an empty database —
 * the startup assertion below catches this configuration error early.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DATABASE_PATH
  || path.resolve(__dirname, '../../db/2step.db');

const messagesDbPath = process.env.MESSAGES_DB_PATH
  || path.resolve(__dirname, '../../../mmo-platform/db/messages.db');

// Startup assertion: if MESSAGES_DB_PATH was explicitly set but the file
// doesn't exist, throw immediately with a clear error rather than silently
// creating an empty database at the wrong path.
if (process.env.MESSAGES_DB_PATH && !existsSync(messagesDbPath)) {
  throw new Error(
    `MESSAGES_DB_PATH is set but file not found: ${messagesDbPath}\n` +
    `Run mmo-platform/scripts/init-messages-db.js first to create the shared DB.`
  );
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');
db.pragma('foreign_keys = ON');

// ATTACH the shared messages DB if it exists.
// busy_timeout is set on the connection and covers all attached databases.
if (existsSync(messagesDbPath)) {
  db.exec(`ATTACH DATABASE '${messagesDbPath}' AS msgs`);
} else {
  // Dev: messages.db not yet initialised — log a warning but don't crash.
  // Pipeline stages that query msgs.messages will fail at query time with a
  // clear "no such table: msgs.messages" error, which is easier to diagnose
  // than a silent missing-DB issue.
  console.warn(
    `[db] WARNING: messages.db not found at ${messagesDbPath}. ` +
    `Run mmo-platform/scripts/init-messages-db.js to create it. ` +
    `Queries against msgs.* will fail until the shared DB is initialised.`
  );
}

export default db;
