/**
 * E2E test database helper.
 *
 * Creates a fully isolated in-memory SQLite database for each test run.
 * Combines both the 2step schema (sites, videos, keywords, niche_tiers) and
 * the mmo-platform messages schema (messages, opt_outs, pricing, etc.) into a
 * single in-memory connection.
 *
 * In production the messages tables live in a separate messages.db ATTACHed as
 * `msgs`. In-memory SQLite cannot ATTACH another in-memory database reliably,
 * so we create the messages tables directly in the same connection without the
 * `msgs.` schema prefix and expose a `db.msgs` alias so test code can use the
 * same query patterns as production code.
 *
 * Usage:
 *   const db = createTestDb();
 *   seedTestSites(db);                    // inserts default prospect rows
 *   seedTestSites(db, [{ ... }]);         // inserts custom rows
 *   seedTestMessages(db, [{ ... }]);      // inserts messages table rows
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../..');

// ─── Schema loading ───────────────────────────────────────────────────────────

function loadSiteSchema() {
  const sql = readFileSync(resolve(root, 'db/schema.sql'), 'utf8');
  // schema.sql uses IF NOT EXISTS so it's safe to run as-is
  return sql;
}

function loadMessagesSchema() {
  const sql = readFileSync(
    resolve(root, '../mmo-platform/db/schema-messages.sql'),
    'utf8'
  );

  // The schema file contains PRAGMA, CREATE TABLE (with multi-line CHECK and
  // DEFAULT expressions that include internal semicolons), CREATE INDEX, and
  // INSERT statements. A naive split(';') breaks CREATE TABLE blocks.
  //
  // Strategy: use multiline regexes to extract TABLE and INDEX DDL independently.

  // Tables must be created before indexes. Extract them separately and
  // return tables first, then indexes.

  // Match: CREATE TABLE ... ); — spans multiple lines; ends at \n); (SQLite convention).
  // This handles CREATE TABLE blocks that contain internal semicolons inside
  // CHECK constraints and DEFAULT expressions.
  const tables = [];
  const tableMatches = sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS[\s\S]*?\n\);/g);
  for (const m of tableMatches) {
    tables.push(m[0].trim());
  }

  // Match: CREATE [UNIQUE] INDEX ... ; (all on one line or trailing ;)
  const indexes = [];
  const indexMatches = sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS[^;]+;/gs);
  for (const m of indexMatches) {
    indexes.push(m[0].trim());
  }

  return [...tables, ...indexes].join(';\n') + ';';
}

// ─── DB factory ───────────────────────────────────────────────────────────────

/**
 * Create and initialise a fresh in-memory test database.
 *
 * Returns the better-sqlite3 Database instance. All tables from both
 * schema files are present in the same DB (no ATTACH needed).
 *
 * The `pricing` table is seeded with representative rows so that the
 * proposals stage can look up pricing_id without needing msgs.pricing.
 *
 * @returns {import('better-sqlite3').Database}
 */
export function createTestDb() {
  const db = new Database(':memory:');

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply 2step site schema
  db.exec(loadSiteSchema());

  // Apply messages schema (tables only — no PRAGMA, no INSERT)
  db.exec(loadMessagesSchema());

  // Seed a minimal pricing row so proposals can resolve pricing_id.
  // Mirrors the INSERT in schema-messages.sql for 2step/AU/standard.
  db.exec(`
    INSERT OR IGNORE INTO pricing
      (project, country_code, niche_tier, setup_local, monthly_4, monthly_8, monthly_12, currency)
    VALUES
      ('2step', 'AU', 'budget',    699,  139, 249, 349, 'AUD'),
      ('2step', 'AU', 'standard',  899,  139, 249, 349, 'AUD'),
      ('2step', 'AU', 'premium',  1099,  139, 249, 349, 'AUD'),
      ('2step', 'US', 'standard',  625,   99, 179, 249, 'USD'),
      ('2step', 'UK', 'standard',  489,   79, 139, 199, 'GBP');
  `);

  return db;
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Seed sites into the test DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object[]} [sites]  - Override array; defaults are used when omitted.
 * @returns {number[]} The row IDs of the inserted sites.
 */
export function seedTestSites(db, sites) {
  const insert = db.prepare(`
    INSERT INTO sites (
      business_name, domain, city, state, country_code, niche,
      google_rating, review_count, status, google_place_id,
      keyword, selected_review_json, problem_category,
      contacts_json, video_url, video_hash
    ) VALUES (
      @business_name, @domain, @city, @state, @country_code, @niche,
      @google_rating, @review_count, @status, @google_place_id,
      @keyword, @selected_review_json, @problem_category,
      @contacts_json, @video_url, @video_hash
    )
  `);

  const rows = sites ?? [
    {
      business_name:        'Acme Pest Control',
      domain:               'acmepest.com.au',
      city:                 'Sydney',
      state:                'NSW',
      country_code:         'AU',
      niche:                'pest control',
      google_rating:        4.8,
      review_count:         156,
      status:               'found',
      google_place_id:      'ChIJ_test_001',
      keyword:              'pest control Sydney',
      selected_review_json: null,
      problem_category:     null,
      contacts_json:        null,
      video_url:            null,
      video_hash:           null,
    },
    {
      business_name:        'Quick Plumbing',
      domain:               'quickplumb.com.au',
      city:                 'Melbourne',
      state:                'VIC',
      country_code:         'AU',
      niche:                'plumber',
      google_rating:        4.6,
      review_count:         89,
      status:               'reviews_downloaded',
      google_place_id:      'ChIJ_test_002',
      keyword:              'plumber Melbourne',
      selected_review_json: JSON.stringify({ text: 'Fixed the blocked drain fast.', author: 'Bob', rating: 5 }),
      problem_category:     'blocked drain',
      contacts_json:        null,
      video_url:            null,
      video_hash:           null,
    },
    {
      business_name:        'Bright Smiles Dental',
      domain:               'brightsmiles.com',
      city:                 'Los Angeles',
      state:                'CA',
      country_code:         'US',
      niche:                'dentist',
      google_rating:        4.9,
      review_count:         312,
      status:               'enriched',
      google_place_id:      'ChIJ_test_003',
      keyword:              'dentist Los Angeles',
      selected_review_json: JSON.stringify({ text: 'Great cleaning, very thorough.', author: 'Alice', rating: 5 }),
      problem_category:     'teeth cleaning',
      contacts_json:        JSON.stringify({ emails: ['info@brightsmiles.com'], phones: [], socials: {} }),
      video_url:            null,
      video_hash:           null,
    },
  ];

  const ids = [];
  for (const row of rows) {
    const info = insert.run({
      business_name:        row.business_name        ?? null,
      domain:               row.domain               ?? null,
      city:                 row.city                 ?? null,
      state:                row.state                ?? null,
      country_code:         row.country_code         ?? 'AU',
      niche:                row.niche                ?? null,
      google_rating:        row.google_rating        ?? null,
      review_count:         row.review_count         ?? null,
      status:               row.status               ?? 'found',
      google_place_id:      row.google_place_id      ?? null,
      keyword:              row.keyword              ?? null,
      selected_review_json: row.selected_review_json ?? null,
      problem_category:     row.problem_category     ?? null,
      contacts_json:        row.contacts_json        ?? null,
      video_url:            row.video_url            ?? null,
      video_hash:           row.video_hash           ?? null,
    });
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

/**
 * Seed a keyword into the test DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} kw
 * @returns {number} lastInsertRowid
 */
export function seedTestKeyword(db, kw = {}) {
  const info = db.prepare(`
    INSERT INTO keywords (keyword, location, country_code, status, priority)
    VALUES (@keyword, @location, @country_code, @status, @priority)
  `).run({
    keyword:      kw.keyword      ?? 'pest control',
    location:     kw.location     ?? 'Sydney',
    country_code: kw.country_code ?? 'AU',
    status:       kw.status       ?? 'active',
    priority:     kw.priority     ?? 5,
  });
  return info.lastInsertRowid;
}

/**
 * Seed messages into the in-memory messages table (no `msgs.` prefix needed).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object[]} messages
 * @returns {number[]} lastInsertRowids
 */
export function seedTestMessages(db, messages = []) {
  const insert = db.prepare(`
    INSERT INTO messages (
      project, site_id, direction, contact_method, contact_uri,
      message_body, subject_line, video_url,
      approval_status, delivery_status, message_type, pricing_id, template_id,
      created_at, updated_at
    ) VALUES (
      @project, @site_id, @direction, @contact_method, @contact_uri,
      @message_body, @subject_line, @video_url,
      @approval_status, @delivery_status, @message_type, @pricing_id, @template_id,
      datetime('now'), datetime('now')
    )
  `);

  const ids = [];
  for (const msg of messages) {
    const info = insert.run({
      project:         msg.project         ?? '2step',
      site_id:         msg.site_id,
      direction:       msg.direction        ?? 'outbound',
      contact_method:  msg.contact_method   ?? 'email',
      contact_uri:     msg.contact_uri      ?? 'test@example.com',
      message_body:    msg.message_body     ?? 'Test body',
      subject_line:    msg.subject_line     ?? 'Test subject',
      video_url:       msg.video_url        ?? null,
      approval_status: msg.approval_status  ?? 'pending',
      delivery_status: msg.delivery_status  ?? null,
      message_type:    msg.message_type     ?? 'outreach',
      pricing_id:      msg.pricing_id       ?? null,
      template_id:     msg.template_id      ?? null,
    });
    ids.push(info.lastInsertRowid);
  }
  return ids;
}

/**
 * Seed an opt-out record into the in-memory opt_outs table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} optOut
 */
export function seedOptOut(db, optOut = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO opt_outs (phone, email, method, project)
    VALUES (@phone, @email, @method, @project)
  `).run({
    phone:   optOut.phone   ?? null,
    email:   optOut.email   ?? null,
    method:  optOut.method  ?? 'email',
    project: optOut.project ?? '2step',
  });
}
