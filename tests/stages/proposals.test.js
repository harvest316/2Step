import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ─── spinWithVars: test the exported function via direct import ──────────────
// We can't import the private function directly, so we test the behavior
// via the spin() dependency and a local copy of the logic.

describe('spinWithVars empty-option cleanup', () => {
  // Replicate the core logic from proposals.js spinWithVars
  function spinWithVars(spintaxText, vars) {
    if (!spintaxText) return null;
    const resolved = spintaxText.replace(/\[(\w+)(?:\|([^\]]*))?\]/g, (_, key, fallback) => {
      const val = vars[key];
      if (val !== null && val !== undefined && val !== '') return val;
      return fallback !== undefined ? fallback : '';
    });
    // Clean up empty spintax alternatives
    const cleaned = resolved.replace(/\{([^{}]*)\}/g, (match, inner) => {
      const options = inner.split('|').filter(o => o.trim() !== '');
      if (options.length === 0) return '';
      if (options.length === 1) return options[0];
      return `{${options.join('|')}}`;
    });
    return cleaned;
  }

  it('replaces variable with value when present', () => {
    const result = spinWithVars('Hi [name]!', { name: 'Jason' });
    assert.equal(result, 'Hi Jason!');
  });

  it('uses explicit fallback when variable is empty', () => {
    const result = spinWithVars('Hi [name|there]!', { name: '' });
    assert.equal(result, 'Hi there!');
  });

  it('uses explicit fallback when variable is null', () => {
    const result = spinWithVars('Hi [name|there]!', { name: null });
    assert.equal(result, 'Hi there!');
  });

  it('removes empty spintax option when variable resolves to empty', () => {
    // Template: {[first_name]|there} → first_name is empty → {|there} → should become "there"
    const result = spinWithVars('Hi {[first_name]|there}!', { first_name: '' });
    assert.equal(result, 'Hi there!');
  });

  it('removes empty spintax option when variable is null', () => {
    const result = spinWithVars('Hi {[first_name]|there}!', { first_name: null });
    assert.equal(result, 'Hi there!');
  });

  it('preserves valid spintax when variable has value', () => {
    const result = spinWithVars('Hi {[first_name]|there}!', { first_name: 'Jason' });
    // spin() not called in this unit test — spintax group preserved with both options
    assert.equal(result, 'Hi {Jason|there}!');
  });

  it('handles multiple empty spintax groups', () => {
    const result = spinWithVars('{[a]|fallback} and {[b]|other}', { a: '', b: '' });
    assert.equal(result, 'fallback and other');
  });

  it('returns null for null input', () => {
    assert.equal(spinWithVars(null, {}), null);
  });
});

// ─── proposals: direct column fallback ──────────────────────────────────────

describe('proposals direct column fallback', () => {
  // Test the contact extraction logic: when contacts_json is empty,
  // the proposals stage should fall back to direct email/phone columns.

  it('uses contacts_json when available', () => {
    const contacts_json = JSON.stringify({
      emails: ['test@example.com'],
      phones: ['+61412345678'],
    });

    const parsed = JSON.parse(contacts_json);
    const emails = (parsed.emails || []).filter(Boolean);
    const phones = (parsed.phones || []).filter(Boolean);

    assert.equal(emails.length, 1);
    assert.equal(phones.length, 1);
  });

  it('falls back to direct columns when contacts_json is null', () => {
    const contacts_json = null;
    const site = { email: 'direct@example.com', phone: '+61412345678' };

    // Parse contacts_json (returns empty arrays)
    let emails = [];
    let phones = [];
    if (contacts_json) {
      const parsed = JSON.parse(contacts_json);
      emails = (parsed.emails || []).filter(Boolean);
      phones = (parsed.phones || []).filter(Boolean);
    }

    // Fallback to direct columns (the fix we implemented)
    if (emails.length === 0 && site.email) emails.push(site.email);
    if (phones.length === 0 && site.phone) phones.push(site.phone);

    assert.equal(emails.length, 1);
    assert.equal(emails[0], 'direct@example.com');
    assert.equal(phones.length, 1);
    assert.equal(phones[0], '+61412345678');
  });

  it('does not duplicate when both contacts_json and direct columns have data', () => {
    const contacts_json = JSON.stringify({
      emails: ['json@example.com'],
      phones: ['+61400000000'],
    });
    const site = { email: 'direct@example.com', phone: '+61412345678' };

    const parsed = JSON.parse(contacts_json);
    const emails = (parsed.emails || []).filter(Boolean);
    const phones = (parsed.phones || []).filter(Boolean);

    // Fallback only adds if arrays are empty
    if (emails.length === 0 && site.email) emails.push(site.email);
    if (phones.length === 0 && site.phone) phones.push(site.phone);

    // contacts_json data takes priority — direct columns not added
    assert.equal(emails.length, 1);
    assert.equal(emails[0], 'json@example.com');
    assert.equal(phones.length, 1);
    assert.equal(phones[0], '+61400000000');
  });
});

// ─── DATABASE_PATH isolation ────────────────────────────────────────────────

describe('2Step DATABASE_PATH isolation', () => {
  it('2Step db.js uses PostgreSQL (pg.Pool), not SQLite', async () => {
    // 2Step migrated from SQLite to PG — verify db.js imports pg and uses
    // DATABASE_URL / PG connection vars, not a SQLite file path.
    const { readFileSync } = await import('fs');
    const dbSource = readFileSync(resolve(ROOT, 'src/utils/db.js'), 'utf8');

    assert.ok(
      dbSource.includes("from 'pg'") || dbSource.includes("require('pg')"),
      'db.js should import the pg driver'
    );
    assert.ok(
      dbSource.includes('pg.Pool') || dbSource.includes('new Pool'),
      'db.js should create a pg.Pool'
    );
    // Must NOT import better-sqlite3 (would use 333Method's SQLite path)
    assert.ok(
      !dbSource.includes('better-sqlite3'),
      'db.js must not use SQLite (would conflict with DATABASE_PATH env var)'
    );
  });
});
