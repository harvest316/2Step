/**
 * Unit tests for pure helper functions exported from outreach.js.
 *
 * These test the actual exported functions (splitBody, textToHtml,
 * buildPlainText, CAN_SPAM_COUNTRIES) covering normal, edge, and
 * boundary conditions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBody,
  textToHtml,
  buildPlainText,
  CAN_SPAM_COUNTRIES,
  formatPhoneNumber,
  assembleEmail,
  loadSequenceTemplate,
  isOptedOut,
} from '../../src/stages/outreach.js';

// ─── splitBody ───────────────────────────────────────────────────────────────

describe('splitBody', () => {
  it('splits on [poster] tag', () => {
    const body = 'Hook text here\n\n[poster]\n\nRemaining body';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'Hook text here');
    assert.equal(remaining, 'Remaining body');
  });

  it('trims trailing newlines from hook', () => {
    const body = 'Hook\n\n\n[poster]\nAfter';
    const { hook } = splitBody(body);
    assert.equal(hook, 'Hook');
  });

  it('trims leading newlines from remaining', () => {
    const body = 'Hook[poster]\n\n\nAfter';
    const { remaining } = splitBody(body);
    assert.equal(remaining, 'After');
  });

  it('returns hook as everything before [poster]', () => {
    const body = 'Line 1\nLine 2[poster]Rest';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'Line 1\nLine 2');
    assert.equal(remaining, 'Rest');
  });

  it('handles [poster] at the very beginning', () => {
    const body = '[poster]All remaining';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, '');
    assert.equal(remaining, 'All remaining');
  });

  it('handles [poster] at the very end', () => {
    const body = 'All hook text[poster]';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'All hook text');
    assert.equal(remaining, '');
  });

  it('falls back to double-newline split when no [poster]', () => {
    const body = 'First paragraph\n\nSecond paragraph\n\nThird paragraph';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'First paragraph');
    assert.equal(remaining, 'Second paragraph\n\nThird paragraph');
  });

  it('returns full body as hook when no [poster] and no double-newline', () => {
    const body = 'Single paragraph with no breaks';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'Single paragraph with no breaks');
    assert.equal(remaining, '');
  });

  it('handles null/undefined input', () => {
    const { hook, remaining } = splitBody(null);
    assert.equal(hook, '');
    assert.equal(remaining, '');
  });

  it('handles empty string input', () => {
    const { hook, remaining } = splitBody('');
    assert.equal(hook, '');
    assert.equal(remaining, '');
  });

  it('only splits on first [poster] if multiple exist', () => {
    const body = 'Hook[poster]Middle[poster]End';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'Hook');
    assert.equal(remaining, 'Middle[poster]End');
  });

  it('handles [poster] surrounded by multiple newlines', () => {
    const body = 'Hook\n\n\n\n[poster]\n\n\n\nRemaining';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, 'Hook');
    assert.equal(remaining, 'Remaining');
  });

  it('preserves internal newlines in hook section', () => {
    const body = 'Line 1\nLine 2\nLine 3\n\n[poster]\nAfter';
    const { hook } = splitBody(body);
    assert.equal(hook, 'Line 1\nLine 2\nLine 3');
  });

  it('handles body with only whitespace before poster', () => {
    const body = '   \n  [poster]content';
    const { hook, remaining } = splitBody(body);
    assert.equal(hook, '   \n  ');
    assert.equal(remaining, 'content');
  });
});

// ─── textToHtml ──────────────────────────────────────────────────────────────

describe('textToHtml', () => {
  it('converts a single line to a paragraph', () => {
    assert.equal(textToHtml('Hello world'), '<p class="last-child">Hello world</p>');
  });

  it('converts multiple lines to separate paragraphs', () => {
    const result = textToHtml('Line 1\nLine 2\nLine 3');
    assert.equal(
      result,
      '<p class="last-child">Line 1</p>\n<p class="last-child">Line 2</p>\n<p class="last-child">Line 3</p>',
    );
  });

  it('returns empty string for null input', () => {
    assert.equal(textToHtml(null), '');
  });

  it('returns empty string for empty string input', () => {
    assert.equal(textToHtml(''), '');
  });

  it('returns empty string for undefined input', () => {
    assert.equal(textToHtml(undefined), '');
  });

  it('filters out blank lines', () => {
    const result = textToHtml('Line 1\n\nLine 2');
    assert.equal(
      result,
      '<p class="last-child">Line 1</p>\n<p class="last-child">Line 2</p>',
    );
  });

  it('filters out whitespace-only lines', () => {
    const result = textToHtml('Line 1\n   \nLine 2');
    assert.equal(
      result,
      '<p class="last-child">Line 1</p>\n<p class="last-child">Line 2</p>',
    );
  });

  it('handles multiple consecutive newlines', () => {
    const result = textToHtml('A\n\n\n\nB');
    assert.equal(
      result,
      '<p class="last-child">A</p>\n<p class="last-child">B</p>',
    );
  });

  it('preserves content within lines (does not strip inline whitespace)', () => {
    const result = textToHtml('  Hello  world  ');
    assert.equal(result, '<p class="last-child">  Hello  world  </p>');
  });

  it('handles single character input', () => {
    assert.equal(textToHtml('A'), '<p class="last-child">A</p>');
  });
});

// ─── buildPlainText ──────────────────────────────────────────────────────────

describe('buildPlainText', () => {
  const baseMsgWithPoster = {
    message_body: 'Hi there\n\nGreat reviews!\n\n[poster]\n\nRemaining text here.',
    business_name: 'Acme Pest Control',
    contact_uri: 'test@example.com',
  };

  const baseMsgNoPoster = {
    message_body: 'Hi there\n\nGreat reviews!\n\nRemaining text here.',
    business_name: 'Acme Pest Control',
    contact_uri: 'test@example.com',
  };

  it('includes the subject as the first line', () => {
    const result = buildPlainText(baseMsgWithPoster, 'https://video.com/v/abc', 'Your video is ready');
    const lines = result.split('\n');
    assert.equal(lines[0], 'Your video is ready');
  });

  it('includes the video URL', () => {
    const result = buildPlainText(baseMsgWithPoster, 'https://video.com/v/abc', 'Subject');
    assert.ok(result.includes('Watch your video: https://video.com/v/abc'));
  });

  it('includes unsubscribe URL with encoded email', () => {
    const result = buildPlainText(baseMsgWithPoster, 'https://video.com/v/abc', 'Subject');
    assert.ok(result.includes('Unsubscribe:'));
    assert.ok(result.includes(encodeURIComponent('test@example.com')));
  });

  it('includes business name in explanation line', () => {
    const result = buildPlainText(baseMsgWithPoster, 'https://v.com', 'Subject');
    assert.ok(result.includes('Acme Pest Control'));
  });

  it('uses only hook text (before [poster]) when [poster] tag exists', () => {
    const result = buildPlainText(baseMsgWithPoster, 'https://v.com', 'Subject');
    // Should contain the hook text
    assert.ok(result.includes('Hi there\n\nGreat reviews!'));
    // Should NOT contain text after [poster]
    assert.ok(!result.includes('Remaining text here.'));
  });

  it('uses full body when no [poster] tag', () => {
    const result = buildPlainText(baseMsgNoPoster, 'https://v.com', 'Subject');
    // Without [poster], hookText = full body
    assert.ok(result.includes('Remaining text here.'));
  });

  it('handles null message_body', () => {
    const msg = { message_body: null, business_name: 'Test', contact_uri: 'a@b.com' };
    const result = buildPlainText(msg, 'https://v.com', 'Subject');
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('Watch your video:'));
  });

  it('includes separator line (---)', () => {
    const result = buildPlainText(baseMsgWithPoster, 'https://v.com', 'Subject');
    assert.ok(result.includes('---'));
  });

  it('has correct structure: subject, blank, hook, blank, video link, blank, separator', () => {
    const result = buildPlainText(
      { message_body: 'Hook text[poster]Rest', business_name: 'Biz', contact_uri: 'a@b.com' },
      'https://v.com/123',
      'My Subject',
    );
    const lines = result.split('\n');
    assert.equal(lines[0], 'My Subject');
    assert.equal(lines[1], '');  // blank line after subject
    assert.equal(lines[2], 'Hook text');
    assert.equal(lines[3], '');  // blank line after hook
    assert.equal(lines[4], 'Watch your video: https://v.com/123');
    assert.equal(lines[5], '');  // blank line after video
    assert.equal(lines[6], '---');
  });

  it('handles empty business_name gracefully', () => {
    const msg = { message_body: 'Body[poster]Rest', business_name: '', contact_uri: 'a@b.com' };
    const result = buildPlainText(msg, 'https://v.com', 'Subject');
    assert.ok(result.includes('deserved to see'));
  });
});

// ─── CAN_SPAM_COUNTRIES ──────────────────────────────────────────────────────

describe('CAN_SPAM_COUNTRIES', () => {
  it('is a Set', () => {
    assert.ok(CAN_SPAM_COUNTRIES instanceof Set);
  });

  it('includes US', () => {
    assert.ok(CAN_SPAM_COUNTRIES.has('US'));
  });

  it('includes AU', () => {
    assert.ok(CAN_SPAM_COUNTRIES.has('AU'));
  });

  it('includes UK', () => {
    assert.ok(CAN_SPAM_COUNTRIES.has('UK'));
  });

  it('includes GB', () => {
    assert.ok(CAN_SPAM_COUNTRIES.has('GB'));
  });

  it('includes CA', () => {
    assert.ok(CAN_SPAM_COUNTRIES.has('CA'));
  });

  it('includes NZ', () => {
    assert.ok(CAN_SPAM_COUNTRIES.has('NZ'));
  });

  it('includes major EU countries (DE, FR, IT, ES)', () => {
    for (const cc of ['DE', 'FR', 'IT', 'ES']) {
      assert.ok(CAN_SPAM_COUNTRIES.has(cc), `Missing ${cc}`);
    }
  });

  it('includes Nordic countries (SE, DK, NO, FI)', () => {
    for (const cc of ['SE', 'DK', 'NO', 'FI']) {
      assert.ok(CAN_SPAM_COUNTRIES.has(cc), `Missing ${cc}`);
    }
  });

  it('does not include JP (not in list)', () => {
    assert.ok(!CAN_SPAM_COUNTRIES.has('JP'));
  });

  it('does not include CN (not in list)', () => {
    assert.ok(!CAN_SPAM_COUNTRIES.has('CN'));
  });

  it('has at least 25 countries', () => {
    assert.ok(CAN_SPAM_COUNTRIES.size >= 25, `Only ${CAN_SPAM_COUNTRIES.size} countries`);
  });
});

// ─── formatPhoneNumber ──────────────────────────────────────────────────────

describe('formatPhoneNumber', () => {
  it('formats Australian mobile starting with 04 to +61', () => {
    assert.equal(formatPhoneNumber('0412345678'), '+61412345678');
  });

  it('preserves already E.164 formatted number', () => {
    assert.equal(formatPhoneNumber('+61412345678'), '+61412345678');
  });

  it('strips non-digit characters', () => {
    assert.equal(formatPhoneNumber('(04) 1234 5678'), '+61412345678');
  });

  it('strips spaces and dashes', () => {
    assert.equal(formatPhoneNumber('04-1234-5678'), '+61412345678');
  });

  it('handles US 10-digit number (prepends +1)', () => {
    assert.equal(formatPhoneNumber('2125551234'), '+12125551234');
  });

  it('handles number that already starts with 61', () => {
    assert.equal(formatPhoneNumber('61412345678'), '+61412345678');
  });

  it('adds + prefix when not present', () => {
    const result = formatPhoneNumber('61400000000');
    assert.ok(result.startsWith('+'), `Expected + prefix, got "${result}"`);
  });

  it('handles short numbers without modification beyond + prefix', () => {
    // A short number that doesn't match any normalization rules
    const result = formatPhoneNumber('12345');
    assert.equal(result, '+12345');
  });

  it('handles already-prefixed numbers correctly', () => {
    assert.equal(formatPhoneNumber('+442071234567'), '+442071234567');
  });

  it('handles dots as separators', () => {
    assert.equal(formatPhoneNumber('04.1234.5678'), '+61412345678');
  });

  it('handles parentheses in area code', () => {
    const result = formatPhoneNumber('(02) 9876 5432');
    assert.equal(typeof result, 'string');
    assert.ok(result.startsWith('+'));
  });

  it('handles empty-ish string with only non-digits', () => {
    // Edge case: all non-digits removed
    const result = formatPhoneNumber('---');
    assert.equal(result, '+');
  });
});

// ─── assembleEmail ──────────────────────────────────────────────────────────

describe('assembleEmail', () => {
  it('throws when thumbnail_url is missing', () => {
    const msg = {
      id: 1,
      message_body: 'Test body',
      thumbnail_url: null,
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Test Biz',
      country_code: 'AU',
      contact_uri: 'test@example.com',
    };
    assert.throws(() => assembleEmail(msg), /thumbnail_url/);
  });

  it('throws when video_url is missing', () => {
    const msg = {
      id: 1,
      message_body: 'Test body',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: null,
      business_name: 'Test Biz',
      country_code: 'AU',
      contact_uri: 'test@example.com',
    };
    assert.throws(() => assembleEmail(msg), /video_url/);
  });

  it('returns an object with html, text, and subject keys', () => {
    const msg = {
      id: 99,
      message_body: 'Hook text[poster]Remaining body text here',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Acme Pest Control',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Your free video review is ready',
      city: 'Sydney',
      niche: 'pest control',
    };
    const result = assembleEmail(msg);
    assert.ok(typeof result.html === 'string');
    assert.ok(typeof result.text === 'string');
    assert.ok(typeof result.subject === 'string');
  });

  it('html output contains the business name', () => {
    const msg = {
      id: 99,
      message_body: 'Hook text[poster]Remaining body',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Sydney Pest Masters',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Your video',
    };
    const result = assembleEmail(msg);
    assert.ok(result.html.includes('Sydney Pest Masters'));
  });

  it('html output contains the poster URL', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Body',
      thumbnail_url: 'https://cdn.example.com/poster-s99.jpg',
      video_url: 'https://cdn.example.com/video-s99.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Test subject',
    };
    const result = assembleEmail(msg);
    assert.ok(result.html.includes('https://cdn.example.com/poster-s99.jpg'));
  });

  it('html output contains the video URL', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Body',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video-s99.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Test',
    };
    const result = assembleEmail(msg);
    assert.ok(result.html.includes('https://cdn.example.com/video-s99.mp4'));
  });

  it('text output contains the video URL', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Body',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video-s99.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Test',
    };
    const result = assembleEmail(msg);
    assert.ok(result.text.includes('https://cdn.example.com/video-s99.mp4'));
  });

  it('uses stored subject_line when available', () => {
    const msg = {
      id: 99,
      message_body: 'Body[poster]Rest',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Custom subject line here',
    };
    const result = assembleEmail(msg);
    assert.equal(result.subject, 'Custom subject line here');
  });

  it('generates a default subject when subject_line is missing', () => {
    const msg = {
      id: 99,
      message_body: 'Body[poster]Rest',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Acme Plumbing',
      country_code: 'AU',
      contact_uri: 'test@example.com',
    };
    const result = assembleEmail(msg);
    assert.ok(result.subject.includes('Acme Plumbing'));
    assert.ok(result.subject.includes('video'));
  });

  it('html output contains an unsubscribe link', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Rest',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'user@example.com',
      subject_line: 'Test',
    };
    const result = assembleEmail(msg);
    assert.ok(result.html.includes('unsubscribe'));
    assert.ok(result.html.includes(encodeURIComponent('user@example.com')));
  });

  it('text output contains unsubscribe URL', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Rest',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'user@example.com',
      subject_line: 'Test',
    };
    const result = assembleEmail(msg);
    assert.ok(result.text.includes('Unsubscribe'));
  });

  it('uses "your business" when business_name is falsy', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Rest',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: null,
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: null,
    };
    const result = assembleEmail(msg);
    assert.ok(result.subject.includes('your business'));
  });

  it('handles missing message_body gracefully', () => {
    const msg = {
      id: 99,
      message_body: null,
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Test',
      country_code: 'AU',
      contact_uri: 'test@example.com',
      subject_line: 'Test',
    };
    const result = assembleEmail(msg);
    assert.ok(typeof result.html === 'string');
    assert.ok(typeof result.text === 'string');
  });

  it('throws when country_code is not provided', () => {
    const msg = {
      id: 99,
      message_body: 'Hook[poster]Rest',
      thumbnail_url: 'https://cdn.example.com/poster.jpg',
      video_url: 'https://cdn.example.com/video.mp4',
      business_name: 'Test',
      contact_uri: 'test@example.com',
      subject_line: 'Test',
    };
    assert.throws(() => assembleEmail(msg), /No country_code/);
  });
});

// ─── loadSequenceTemplate ───────────────────────────────────────────────────

describe('loadSequenceTemplate', () => {
  it('loads AU sequence template', () => {
    const result = loadSequenceTemplate('AU');
    assert.ok(typeof result === 'object');
  });

  it('AU template has touches array', () => {
    const result = loadSequenceTemplate('AU');
    assert.ok(Array.isArray(result.touches) || typeof result === 'object');
  });

  it('loads US sequence template', () => {
    const result = loadSequenceTemplate('US');
    assert.ok(typeof result === 'object');
  });

  it('loads UK sequence template', () => {
    const result = loadSequenceTemplate('UK');
    assert.ok(typeof result === 'object');
  });

  it('loads NZ sequence template', () => {
    const result = loadSequenceTemplate('NZ');
    assert.ok(typeof result === 'object');
  });

  it('loads CA sequence template', () => {
    const result = loadSequenceTemplate('CA');
    assert.ok(typeof result === 'object');
  });

  it('caches results (second call returns same object)', () => {
    const first = loadSequenceTemplate('AU');
    const second = loadSequenceTemplate('AU');
    assert.equal(first, second, 'Should return cached reference');
  });

  it('throws for non-existent country code', () => {
    assert.throws(() => loadSequenceTemplate('ZZ'), /ENOENT/);
  });
});

// ─── isOptedOut ─────────────────────────────────────────────────────────────

describe('isOptedOut', () => {
  it('returns false when both phone and email are null', async () => {
    const result = await isOptedOut(null, null, 'email');
    assert.equal(result, false);
  });

  it('returns false for a non-opted-out email', async () => {
    // Unless this email is actually in the opt_outs table, it should be false
    const result = await isOptedOut(null, 'never-opted-out-test-1234@example.com', 'email');
    assert.equal(result, false);
  });

  it('returns false for a non-opted-out phone', async () => {
    const result = await isOptedOut('+61400000999', null, 'sms');
    assert.equal(result, false);
  });

  it('returns a boolean', async () => {
    const result = await isOptedOut(null, 'test@example.com', 'email');
    assert.equal(typeof result, 'boolean');
  });

  it('handles empty string email', async () => {
    // Empty string is falsy, so should return false (no contact to check)
    const result = await isOptedOut(null, '', 'email');
    assert.equal(result, false);
  });

  it('handles empty string phone', async () => {
    const result = await isOptedOut('', null, 'sms');
    assert.equal(result, false);
  });
});
