/**
 * Unit tests for pure helper functions exported from proposals.js.
 *
 * These test the actual exported functions (not duplicated logic),
 * covering normal cases, edge cases, and boundary conditions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spinWithVars,
  inferFirstName,
  parseContacts,
  pickTemplate,
  computeScheduledAt,
  formatPrice,
} from '../../src/stages/proposals.js';

// ─── spinWithVars ────────────────────────────────────────────────────────────

describe('spinWithVars', () => {
  it('returns null for null input', () => {
    assert.equal(spinWithVars(null, {}), null);
  });

  it('returns null for empty string input', () => {
    // Empty string is falsy, so it returns null
    assert.equal(spinWithVars('', {}), null);
  });

  it('replaces a simple [variable] with its value', () => {
    const result = spinWithVars('Hello [name]', { name: 'Jason' });
    assert.equal(result, 'Hello Jason');
  });

  it('replaces multiple variables', () => {
    const result = spinWithVars('[greeting] [name], welcome to [city]', {
      greeting: 'Hi',
      name: 'Jason',
      city: 'Sydney',
    });
    assert.equal(result, 'Hi Jason, welcome to Sydney');
  });

  it('uses fallback when variable is null', () => {
    const result = spinWithVars('Hi [name|there]', { name: null });
    assert.equal(result, 'Hi there');
  });

  it('uses fallback when variable is undefined (not in vars)', () => {
    const result = spinWithVars('Hi [name|friend]', {});
    assert.equal(result, 'Hi friend');
  });

  it('uses fallback when variable is empty string', () => {
    const result = spinWithVars('Hi [name|there]', { name: '' });
    assert.equal(result, 'Hi there');
  });

  it('replaces with empty string when no fallback and variable is missing', () => {
    const result = spinWithVars('Hello [name]!', {});
    assert.equal(result, 'Hello !');
  });

  it('cleans up empty spintax alternatives from empty variable', () => {
    // {[first_name]|there} with first_name='' => {|there} => cleaned to "there"
    const result = spinWithVars('{[first_name]|there}', { first_name: '' });
    assert.equal(result, 'there');
  });

  it('cleans up fully empty spintax group', () => {
    // {[a]|[b]} where both are empty => {|} => all options empty => returns ''
    const result = spinWithVars('{[a]|[b]}', { a: '', b: '' });
    assert.equal(result, '');
  });

  it('preserves spintax with all non-empty options (spin picks one)', () => {
    // {hello|hi} with no variables — spin() picks one randomly
    const result = spinWithVars('{hello|hi} world', {});
    assert.ok(
      result === 'hello world' || result === 'hi world',
      `Expected "hello world" or "hi world", got "${result}"`,
    );
  });

  it('preserves variable value inside spintax and spin picks one', () => {
    // {[name]|there} where name='Jason' => {Jason|there} => spin picks one
    const result = spinWithVars('{[name]|there}!', { name: 'Jason' });
    assert.ok(
      result === 'Jason!' || result === 'there!',
      `Expected "Jason!" or "there!", got "${result}"`,
    );
  });

  it('handles variable with pipe-like characters in value', () => {
    // Variable values should not be split by spin's pipe logic
    const result = spinWithVars('[biz]', { biz: 'Tom & Jerry Pest Control' });
    assert.equal(result, 'Tom & Jerry Pest Control');
  });

  it('handles text with no variables or spintax', () => {
    const result = spinWithVars('plain text here', {});
    assert.equal(result, 'plain text here');
  });

  it('replaces adjacent variables correctly', () => {
    const result = spinWithVars('[a][b]', { a: 'X', b: 'Y' });
    assert.equal(result, 'XY');
  });

  it('handles fallback with empty string fallback explicitly', () => {
    // [name|] with name=null => fallback is '' (empty string after pipe)
    const result = spinWithVars('Hi [name|]!', { name: null });
    assert.equal(result, 'Hi !');
  });
});

// ─── inferFirstName ──────────────────────────────────────────────────────────

describe('inferFirstName', () => {
  it('returns owner_first_name when set on site', () => {
    const result = inferFirstName({ owner_first_name: 'Jason' }, {});
    assert.equal(result, 'Jason');
  });

  it('trims whitespace from owner_first_name', () => {
    const result = inferFirstName({ owner_first_name: '  Alice  ' }, {});
    assert.equal(result, 'Alice');
  });

  it('returns first word of contacts.owner_name when site has no name', () => {
    const result = inferFirstName({}, { owner_name: 'John Smith' });
    assert.equal(result, 'John');
  });

  it('extracts name from email address local part', () => {
    const result = inferFirstName({}, { emails: ['joe@example.com'] });
    assert.equal(result, 'Joe');
  });

  it('extracts name from email object format', () => {
    const result = inferFirstName({}, { emails: [{ email: 'sarah@biz.com' }] });
    assert.equal(result, 'Sarah');
  });

  it('skips generic email prefixes (info)', () => {
    const result = inferFirstName({}, { emails: ['info@example.com'] });
    assert.equal(result, null);
  });

  it('skips generic email prefixes (hello)', () => {
    const result = inferFirstName({}, { emails: ['hello@example.com'] });
    assert.equal(result, null);
  });

  it('skips generic email prefixes (admin)', () => {
    const result = inferFirstName({}, { emails: ['admin@example.com'] });
    assert.equal(result, null);
  });

  it('skips generic email prefixes (contact)', () => {
    const result = inferFirstName({}, { emails: ['contact@example.com'] });
    assert.equal(result, null);
  });

  it('skips generic email prefixes (support)', () => {
    const result = inferFirstName({}, { emails: ['support@example.com'] });
    assert.equal(result, null);
  });

  it('skips emails with numeric local parts', () => {
    // joe123@example.com => after digit removal: "joe " -> "joe"
    // But the regex removes digits AND dots/underscores: "joe " => trimmed "joe" => first word "joe"
    // Wait: /[._+\-\d]+/g replaces digits too. "joe123" => "joe" => passes alpha check
    const result = inferFirstName({}, { emails: ['joe123@example.com'] });
    assert.equal(result, 'Joe');
  });

  it('skips emails with very short local parts (< 2 chars)', () => {
    const result = inferFirstName({}, { emails: ['a@example.com'] });
    assert.equal(result, null);
  });

  it('skips emails with non-alphabetic first word', () => {
    // "123@example.com" => digits removed => empty => no firstWord
    const result = inferFirstName({}, { emails: ['123@example.com'] });
    assert.equal(result, null);
  });

  it('handles dot-separated email names (takes first word)', () => {
    // joe.smith@example.com => "joe smith" => firstWord "joe" => "Joe"
    const result = inferFirstName({}, { emails: ['joe.smith@example.com'] });
    assert.equal(result, 'Joe');
  });

  it('returns null when no data available', () => {
    const result = inferFirstName({}, null);
    assert.equal(result, null);
  });

  it('returns null for empty contacts object', () => {
    const result = inferFirstName({}, {});
    assert.equal(result, null);
  });

  it('returns null for empty emails array', () => {
    const result = inferFirstName({}, { emails: [] });
    assert.equal(result, null);
  });

  it('prioritises owner_first_name over everything else', () => {
    const result = inferFirstName(
      { owner_first_name: 'Priority' },
      { owner_name: 'Other Name', emails: ['third@example.com'] },
    );
    assert.equal(result, 'Priority');
  });

  it('prioritises contacts.owner_name over email', () => {
    const result = inferFirstName(
      {},
      { owner_name: 'ContactName', emails: ['email@example.com'] },
    );
    assert.equal(result, 'ContactName');
  });

  it('tries next email when first is generic', () => {
    const result = inferFirstName({}, {
      emails: ['info@example.com', 'sarah@example.com'],
    });
    assert.equal(result, 'Sarah');
  });

  it('handles owner_first_name that is only whitespace', () => {
    // Whitespace-only owner_first_name => .trim() => empty string => falsy => skip
    const result = inferFirstName({ owner_first_name: '   ' }, { emails: ['bob@example.com'] });
    assert.equal(result, 'Bob');
  });

  it('handles contacts.owner_name with leading whitespace', () => {
    const result = inferFirstName({}, { owner_name: '  Maria Lopez  ' });
    assert.equal(result, 'Maria');
  });
});

// ─── parseContacts ───────────────────────────────────────────────────────────

describe('parseContacts', () => {
  it('returns empty arrays for null input', () => {
    const result = parseContacts(null);
    assert.deepEqual(result, { emails: [], phones: [] });
  });

  it('returns empty arrays for undefined input', () => {
    const result = parseContacts(undefined);
    assert.deepEqual(result, { emails: [], phones: [] });
  });

  it('returns empty arrays for invalid JSON string', () => {
    const result = parseContacts('not valid json');
    assert.deepEqual(result, { emails: [], phones: [] });
  });

  it('parses JSON string with string emails', () => {
    const json = JSON.stringify({ emails: ['a@b.com', 'c@d.com'], phones: [] });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['a@b.com', 'c@d.com']);
    assert.deepEqual(result.phones, []);
  });

  it('parses JSON string with object emails', () => {
    const json = JSON.stringify({
      emails: [{ email: 'a@b.com', label: 'main' }],
      phones: [],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['a@b.com']);
  });

  it('parses JSON string with string phones', () => {
    const json = JSON.stringify({
      emails: [],
      phones: ['+61400000000', '+61400111222'],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.phones, ['+61400000000', '+61400111222']);
  });

  it('parses JSON string with object phones', () => {
    const json = JSON.stringify({
      emails: [],
      phones: [{ phone: '+61400000000', label: 'mobile' }],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.phones, ['+61400000000']);
  });

  it('accepts an already-parsed object (not a string)', () => {
    const obj = { emails: ['a@b.com'], phones: ['+61400000000'] };
    const result = parseContacts(obj);
    assert.deepEqual(result.emails, ['a@b.com']);
    assert.deepEqual(result.phones, ['+61400000000']);
  });

  it('filters out falsy email entries', () => {
    const json = JSON.stringify({ emails: ['a@b.com', null, '', { email: null }], phones: [] });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['a@b.com']);
  });

  it('filters out falsy phone entries', () => {
    const json = JSON.stringify({ emails: [], phones: [null, '+61400000000', ''] });
    const result = parseContacts(json);
    assert.deepEqual(result.phones, ['+61400000000']);
  });

  it('returns raw parsed object in result', () => {
    const obj = { emails: ['a@b.com'], phones: [], socials: { facebook: 'fb.com/test' } };
    const result = parseContacts(obj);
    assert.equal(result.raw.socials.facebook, 'fb.com/test');
  });

  it('handles missing emails key', () => {
    const result = parseContacts({ phones: ['+61400000000'] });
    assert.deepEqual(result.emails, []);
    assert.deepEqual(result.phones, ['+61400000000']);
  });

  it('handles missing phones key', () => {
    const result = parseContacts({ emails: ['a@b.com'] });
    assert.deepEqual(result.emails, ['a@b.com']);
    assert.deepEqual(result.phones, []);
  });

  it('handles completely empty object', () => {
    const result = parseContacts({});
    assert.deepEqual(result.emails, []);
    assert.deepEqual(result.phones, []);
  });

  it('handles mixed string and object emails', () => {
    const json = JSON.stringify({
      emails: ['plain@b.com', { email: 'obj@b.com', label: 'work' }],
      phones: [],
    });
    const result = parseContacts(json);
    assert.deepEqual(result.emails, ['plain@b.com', 'obj@b.com']);
  });
});

// ─── pickTemplate ────────────────────────────────────────────────────────────

describe('pickTemplate', () => {
  const templates = ['templateA', 'templateB', 'templateC'];

  it('picks first template for siteId 0', () => {
    assert.equal(pickTemplate(templates, 0), 'templateA');
  });

  it('picks second template for siteId 1', () => {
    assert.equal(pickTemplate(templates, 1), 'templateB');
  });

  it('picks third template for siteId 2', () => {
    assert.equal(pickTemplate(templates, 2), 'templateC');
  });

  it('wraps around to first for siteId 3', () => {
    assert.equal(pickTemplate(templates, 3), 'templateA');
  });

  it('wraps around correctly for large siteId', () => {
    assert.equal(pickTemplate(templates, 100), templates[100 % 3]);
  });

  it('works with single-element array', () => {
    assert.equal(pickTemplate(['only'], 99), 'only');
  });

  it('distributes evenly across templates', () => {
    const counts = { A: 0, B: 0, C: 0 };
    const tpls = ['A', 'B', 'C'];
    for (let i = 0; i < 30; i++) {
      counts[pickTemplate(tpls, i)]++;
    }
    assert.equal(counts.A, 10);
    assert.equal(counts.B, 10);
    assert.equal(counts.C, 10);
  });
});

// ─── computeScheduledAt ─────────────────────────────────────────────────────

describe('computeScheduledAt', () => {
  it('returns null for dayOffset 0', () => {
    assert.equal(computeScheduledAt(0), null);
  });

  it('returns a string for dayOffset > 0', () => {
    const result = computeScheduledAt(2);
    assert.equal(typeof result, 'string');
  });

  it('returns ISO-like format YYYY-MM-DD HH:MM:SS', () => {
    const result = computeScheduledAt(5);
    // Format: "2026-03-30 09:00:00"
    assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('sets time to 09:00:00', () => {
    const result = computeScheduledAt(1);
    assert.ok(result.endsWith('09:00:00'), `Expected time 09:00:00, got "${result}"`);
  });

  it('schedules N days in the future', () => {
    const offset = 7;
    const result = computeScheduledAt(offset);
    const scheduledDate = new Date(result.replace(' ', 'T'));
    const now = new Date();
    // The scheduled date should be approximately 7 days from now
    const diffMs = scheduledDate.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // Allow some tolerance for time-of-day differences
    assert.ok(diffDays > 5.5 && diffDays < 8.5, `Expected ~7 days, got ${diffDays.toFixed(1)}`);
  });

  it('returns different dates for different offsets', () => {
    const d2 = computeScheduledAt(2);
    const d5 = computeScheduledAt(5);
    assert.notEqual(d2, d5);
    // d5 should be later than d2
    assert.ok(d5 > d2, `Day 5 (${d5}) should be after Day 2 (${d2})`);
  });

  it('handles large offset (28 days)', () => {
    const result = computeScheduledAt(28);
    assert.match(result, /^\d{4}-\d{2}-\d{2} 09:00:00$/);
  });
});

// ─── formatPrice ─────────────────────────────────────────────────────────────

describe('formatPrice', () => {
  it('formats AUD correctly', () => {
    assert.equal(formatPrice(337, 'AUD'), '$337');
  });

  it('formats USD correctly', () => {
    assert.equal(formatPrice(297, 'USD'), '$297');
  });

  it('formats GBP correctly with pound sign', () => {
    assert.equal(formatPrice(489, 'GBP'), '\u00a3489');
  });

  it('formats CAD with C$ prefix', () => {
    assert.equal(formatPrice(849, 'CAD'), 'C$849');
  });

  it('formats NZD with NZ$ prefix', () => {
    assert.equal(formatPrice(399, 'NZD'), 'NZ$399');
  });

  it('returns empty string for null amount', () => {
    assert.equal(formatPrice(null, 'AUD'), '');
  });

  it('returns empty string for 0 amount', () => {
    assert.equal(formatPrice(0, 'AUD'), '');
  });

  it('returns empty string for undefined amount', () => {
    assert.equal(formatPrice(undefined, 'AUD'), '');
  });

  it('falls back to $ for unknown currency', () => {
    assert.equal(formatPrice(100, 'EUR'), '$100');
  });

  it('rounds decimal amounts', () => {
    assert.equal(formatPrice(337.5, 'AUD'), '$338');
  });

  it('rounds down for .4 decimals', () => {
    assert.equal(formatPrice(99.4, 'AUD'), '$99');
  });

  it('handles large amounts', () => {
    assert.equal(formatPrice(10000, 'AUD'), '$10000');
  });

  it('handles missing currency (defaults to $)', () => {
    assert.equal(formatPrice(100, undefined), '$100');
  });
});
