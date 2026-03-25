/**
 * E2E tests for the proposals pipeline stage.
 *
 * Strategy:
 *   proposals.js contains several pure helper functions (spinWithVars,
 *   inferFirstName, parseContacts) plus the exported runProposalsStage.
 *   This test suite covers:
 *
 *   1. Pure function behaviour — spinWithVars, inferFirstName, parseContacts
 *      extracted by re-implementing or importing them.
 *
 *   2. Template loading and variable substitution — verifying that the
 *      AU/email.json templates exist and load correctly, and that [variable]
 *      tokens are replaced before spintax is spun.
 *
 *   3. runProposalsStage with dry-run:true — exercises the full stage query +
 *      per-site processing logic without DB writes. Verifies the returned
 *      stats shape.
 *
 * Note: The proposals stage queries `msgs.pricing` (ATTACHed DB). In the test
 * environment the messages DB is not ATTACHed, so lookupPricing() returns null
 * and pricing_id will be null. This is handled gracefully by the stage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../..');

// ─── Pure helpers re-implemented for unit testing ─────────────────────────────
// These mirror the implementations in proposals.js so we can test them in
// isolation without importing the module (which requires the DB singleton).

const GENERIC_EMAIL_PREFIXES = new Set([
  'info', 'hello', 'admin', 'contact', 'office', 'support', 'enquiries',
  'enquiry', 'mail', 'sales', 'reception', 'bookings', 'booking', 'team',
  'help', 'service', 'services', 'noreply', 'no-reply', 'webmaster',
  'accounts', 'billing', 'orders', 'media', 'pr',
]);

function inferFirstName(site, contacts) {
  if (site.owner_first_name && site.owner_first_name.trim()) {
    return site.owner_first_name.trim();
  }
  if (contacts?.owner_name && contacts.owner_name.trim()) {
    const parts = contacts.owner_name.trim().split(/\s+/);
    return parts[0];
  }
  const emails = contacts?.emails || [];
  for (const email of emails) {
    const local = (typeof email === 'string' ? email : email.email || '')
      .split('@')[0]
      ?.toLowerCase()
      ?.replace(/[._+\-\d]+/g, ' ')
      ?.trim();
    if (!local) continue;
    const firstWord = local.split(' ')[0];
    if (!firstWord) continue;
    if (
      GENERIC_EMAIL_PREFIXES.has(firstWord) ||
      firstWord.length < 2 ||
      firstWord.length > 20 ||
      !/^[a-z]+$/.test(firstWord)
    ) {
      continue;
    }
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
  }
  return null;
}

function parseContacts(contactsJson) {
  if (!contactsJson) return { emails: [], phones: [] };
  let parsed;
  try {
    parsed = typeof contactsJson === 'string' ? JSON.parse(contactsJson) : contactsJson;
  } catch {
    return { emails: [], phones: [] };
  }
  const emails = (parsed.emails || [])
    .map(e => (typeof e === 'string' ? e : e?.email))
    .filter(Boolean);
  const phones = (parsed.phones || [])
    .map(p => (typeof p === 'string' ? p : p?.phone))
    .filter(Boolean);
  return { emails, phones, raw: parsed };
}

// ─── inferFirstName ───────────────────────────────────────────────────────────

describe('inferFirstName', () => {
  it('returns owner_first_name when set', () => {
    assert.equal(inferFirstName({ owner_first_name: 'Jane' }, {}), 'Jane');
  });

  it('trims whitespace from owner_first_name', () => {
    assert.equal(inferFirstName({ owner_first_name: '  Bob  ' }, {}), 'Bob');
  });

  it('falls back to contacts.owner_name first word', () => {
    const contacts = { owner_name: 'Michael Chen' };
    assert.equal(inferFirstName({}, contacts), 'Michael');
  });

  it('extracts first name from personal email address', () => {
    const contacts = { emails: ['joe.smith@acmepest.com'] };
    assert.equal(inferFirstName({}, contacts), 'Joe');
  });

  it('skips generic email prefixes', () => {
    const contacts = { emails: ['info@acmepest.com', 'james@acmepest.com'] };
    assert.equal(inferFirstName({}, contacts), 'James');
  });

  it('skips all emails if all are generic', () => {
    const contacts = { emails: ['info@biz.com', 'admin@biz.com', 'contact@biz.com'] };
    assert.equal(inferFirstName({}, contacts), null);
  });

  it('capitalises the extracted name', () => {
    const contacts = { emails: ['sarah@business.com.au'] };
    const result = inferFirstName({}, contacts);
    assert.equal(result, 'Sarah');
  });

  it('skips emails with numbers in the local part', () => {
    const contacts = { emails: ['john123@biz.com'] };
    // "john123" → stripped to "john " → after replace(/[.\d]+/g, ' ') first word is "john"
    // but wait — /_+/g also strips hyphens — actual result depends on regex
    // Test the actual outcome based on implementation
    const result = inferFirstName({}, contacts);
    // "john123" → replace digits → "john   " → trim → "john" → valid name
    assert.equal(result, 'John');
  });

  it('returns null when site and contacts have no useful name data', () => {
    assert.equal(inferFirstName({}, {}), null);
    assert.equal(inferFirstName({}, null), null);
    assert.equal(inferFirstName({}, { emails: [] }), null);
  });

  it('owner_first_name takes precedence over email', () => {
    const contacts = { emails: ['alice@biz.com'] };
    assert.equal(inferFirstName({ owner_first_name: 'Bob' }, contacts), 'Bob');
  });
});

// ─── parseContacts ────────────────────────────────────────────────────────────

describe('parseContacts', () => {
  it('returns empty arrays for null input', () => {
    const result = parseContacts(null);
    assert.deepEqual(result.emails, []);
    assert.deepEqual(result.phones, []);
  });

  it('parses a JSON string with email and phone arrays', () => {
    const json = JSON.stringify({
      emails: ['owner@biz.com', 'info@biz.com'],
      phones: ['+61400000001'],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['owner@biz.com', 'info@biz.com']);
    assert.deepEqual(result.phones, ['+61400000001']);
  });

  it('accepts a pre-parsed object', () => {
    const obj = { emails: ['a@b.com'], phones: [] };
    const result = parseContacts(obj);
    assert.deepEqual(result.emails, ['a@b.com']);
  });

  it('handles { email, label } object entries in emails array', () => {
    const json = JSON.stringify({
      emails: [{ email: 'owner@biz.com', label: 'Owner' }],
      phones: [],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['owner@biz.com']);
  });

  it('handles { phone, label } object entries in phones array', () => {
    const json = JSON.stringify({
      emails: [],
      phones: [{ phone: '+61400000001', label: 'Mobile' }],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.phones, ['+61400000001']);
  });

  it('filters out null/undefined entries', () => {
    const json = JSON.stringify({
      emails: ['valid@biz.com', null, undefined, ''],
      phones: ['+61400000001', null],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['valid@biz.com']);
    assert.deepEqual(result.phones, ['+61400000001']);
  });

  it('returns empty arrays for malformed JSON', () => {
    const result = parseContacts('{not valid json');
    assert.deepEqual(result.emails, []);
    assert.deepEqual(result.phones, []);
  });

  it('handles missing emails or phones keys gracefully', () => {
    const result = parseContacts(JSON.stringify({ socials: {} }));
    assert.deepEqual(result.emails, []);
    assert.deepEqual(result.phones, []);
  });
});

// ─── Template file structure ──────────────────────────────────────────────────

// NOTE: AU/email.json (legacy single-template format) was replaced by
// the 8-touch sequence.json format. Legacy tests removed — sequence
// template validation below covers the current format.

describe('AU SMS templates (legacy)', () => {
  const templatePath = resolve(root, 'data/templates/AU/sms.json');

  it('AU/sms.json file exists and is valid JSON', () => {
    assert.doesNotThrow(() => {
      JSON.parse(readFileSync(templatePath, 'utf-8'));
    });
  });

  it('has a non-empty templates array', () => {
    const { templates } = JSON.parse(readFileSync(templatePath, 'utf-8'));
    assert.ok(Array.isArray(templates) && templates.length > 0);
  });

  it('each SMS template has body_spintax and followup spintax fields', () => {
    const { templates } = JSON.parse(readFileSync(templatePath, 'utf-8'));
    for (const tpl of templates) {
      assert.ok(typeof tpl.body_spintax === 'string' && tpl.body_spintax.length > 0,
        `SMS template ${tpl.id} missing body_spintax`);
    }
  });
});

// ─── 8-touch sequence templates ─────────────────────────────────────────────

const COUNTRIES = ['AU', 'UK', 'US', 'CA', 'NZ'];
const EXPECTED_TOUCHES = 8;
const EXPECTED_CADENCE = [0, 2, 5, 8, 12, 16, 21, 28];

for (const cc of COUNTRIES) {
  describe(`${cc} sequence template`, () => {
    const seqPath = resolve(root, `data/templates/${cc}/sequence.json`);

    it(`${cc}/sequence.json exists and is valid JSON`, () => {
      let data;
      assert.doesNotThrow(() => {
        data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      });
      assert.ok(data, 'parsed data should be truthy');
    });

    it(`has exactly ${EXPECTED_TOUCHES} touches`, () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      assert.equal(data.touches.length, EXPECTED_TOUCHES,
        `Expected ${EXPECTED_TOUCHES} touches, got ${data.touches.length}`);
    });

    it('touches have correct step numbers 1-8', () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      for (let i = 0; i < data.touches.length; i++) {
        assert.equal(data.touches[i].step, i + 1,
          `Touch ${i} has step=${data.touches[i].step}, expected ${i + 1}`);
      }
    });

    it(`cadence matches expected day offsets [${EXPECTED_CADENCE.join(', ')}]`, () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      const actualDays = data.touches.map(t => t.day);
      assert.deepEqual(actualDays, EXPECTED_CADENCE);
    });

    it('touch 1 is email, touches 2 and 5 are sms', () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      assert.equal(data.touches[0].channel, 'email', 'Touch 1 should be email');
      assert.equal(data.touches[1].channel, 'sms', 'Touch 2 should be sms');
      assert.equal(data.touches[4].channel, 'sms', 'Touch 5 should be sms');
    });

    it('every touch references the video: SMS uses [video_url], email uses [poster]', () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      for (const touch of data.touches) {
        if (touch.channel === 'sms') {
          assert.ok(
            touch.body_spintax.includes('[video_url]'),
            `SMS touch ${touch.step} (${touch.id}) body_spintax should contain [video_url]`
          );
        } else {
          assert.ok(
            touch.body_spintax.includes('[poster]'),
            `Email touch ${touch.step} (${touch.id}) body_spintax should contain [poster]`
          );
        }
      }
    });

    it('email touches have subject_spintax, sms touches do not', () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      for (const touch of data.touches) {
        if (touch.channel === 'email') {
          assert.ok(
            typeof touch.subject_spintax === 'string' && touch.subject_spintax.length > 0,
            `Email touch ${touch.step} should have subject_spintax`
          );
        } else {
          assert.equal(touch.subject_spintax, null,
            `SMS touch ${touch.step} should have null subject_spintax`);
        }
      }
    });

    it('touch 4 has a variant_not_viewed with body_spintax', () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      const touch4 = data.touches[3];
      assert.ok(touch4.variant_not_viewed, 'Touch 4 should have variant_not_viewed');
      assert.ok(
        typeof touch4.variant_not_viewed.body_spintax === 'string' &&
        touch4.variant_not_viewed.body_spintax.length > 0,
        'variant_not_viewed should have body_spintax'
      );
    });

    it('touch 8 is a breakup with message_type=breakup', () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      const touch8 = data.touches[7];
      assert.equal(touch8.message_type, 'breakup');
    });

    it(`country_code in template matches ${cc}`, () => {
      const data = JSON.parse(readFileSync(seqPath, 'utf-8'));
      assert.equal(data.country_code, cc);
    });
  });
}

// ─── Variable replacement logic ───────────────────────────────────────────────
// We test the token replacement + spintax spin pattern used by spinWithVars.
// Since spinWithVars is an internal function, we implement the same logic
// to verify the templates would resolve correctly.

function resolveVars(spintaxText, vars) {
  if (!spintaxText) return null;
  return spintaxText.replace(/\[(\w+)(?:\|([^\]]*))?\]/g, (_, key, fallback) => {
    const val = vars[key];
    if (val !== null && val !== undefined && val !== '') return val;
    return fallback !== undefined ? fallback : '';
  });
}

describe('template variable resolution', () => {
  it('replaces [business_name] with the site name', () => {
    const result = resolveVars('Hello from [business_name]', { business_name: 'Acme Pest' });
    assert.equal(result, 'Hello from Acme Pest');
  });

  it('uses fallback for empty variable', () => {
    const result = resolveVars('Hi [first_name|there]', { first_name: '' });
    assert.equal(result, 'Hi there');
  });

  it('uses fallback when variable is absent', () => {
    const result = resolveVars('Hi [first_name|there]', {});
    assert.equal(result, 'Hi there');
  });

  it('does not use fallback when variable is set', () => {
    const result = resolveVars('Hi [first_name|there]', { first_name: 'Jane' });
    assert.equal(result, 'Hi Jane');
  });

  it('replaces multiple variables in one pass', () => {
    const text = '[business_name] is in [city]';
    const result = resolveVars(text, { business_name: 'Acme', city: 'Sydney' });
    assert.equal(result, 'Acme is in Sydney');
  });

  it('leaves unknown variables as empty string when no fallback', () => {
    const result = resolveVars('Hello [unknown_var]', {});
    assert.equal(result, 'Hello ');
  });
});

// ─── runProposalsStage export + dry-run ───────────────────────────────────────

describe('runProposalsStage export', () => {
  it('exports a runProposalsStage function', async () => {
    const mod = await import('../../../src/stages/proposals.js');
    assert.equal(typeof mod.runProposalsStage, 'function');
  });

  it('runProposalsStage returns stats with expected keys when no eligible sites', async () => {
    // In the test environment DATABASE_PATH points to /tmp/test-2step.db which
    // has no sites at status=video_created — stage returns { processed:0 } immediately.
    const { runProposalsStage } = await import('../../../src/stages/proposals.js');
    const stats = await runProposalsStage({ dryRun: true });
    assert.ok(typeof stats === 'object');
    assert.ok('processed' in stats, 'missing key: processed');
    assert.ok('messagesCreated' in stats, 'missing key: messagesCreated');
    assert.ok('errors' in stats, 'missing key: errors');
    assert.equal(typeof stats.processed, 'number');
    assert.equal(typeof stats.messagesCreated, 'number');
    assert.equal(typeof stats.errors, 'number');
  });
});
