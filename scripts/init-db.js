#!/usr/bin/env node

/**
 * Initialize the 2Step SQLite database from schema.sql.
 * Usage: node scripts/init-db.js
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dbPath = process.env.DATABASE_PATH || resolve(root, 'db/2step.db');
const schemaPath = resolve(root, 'db/schema.sql');

console.log(`Initializing database at: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(schemaPath, 'utf8');
db.exec(schema);

// Verify tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(`Tables created: ${tables.map(t => t.name).join(', ')}`);

const counts = tables
  .filter(t => t.name !== 'sqlite_sequence')
  .map(t => {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get().c;
    return `${t.name}: ${count}`;
  });
console.log(`Row counts: ${counts.join(', ')}`);

db.close();
console.log('Database initialized successfully.');
