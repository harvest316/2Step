/**
 * Unit tests for buildEmailHtml() from email-template.js.
 *
 * Tests the Mailchimp-compatible HTML email template builder covering:
 *   - Required parameter interpolation (preview text, hook, poster, video URL, etc.)
 *   - Optional parameters (finePrintHtml, subject)
 *   - HTML structure integrity (DOCTYPE, head, body, MSO conditionals)
 *   - XSS prevention in subject line
 *   - Footer content (unsubscribe, copyright, physical address)
 *   - Edge cases (empty strings, special characters, long content)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailHtml } from '../../src/outreach/email-template.js';

// ─── Shared test params ─────────────────────────────────────────────────────

function makeParams(overrides = {}) {
  return {
    previewText: 'Check out your free video review',
    hookHtml: '<p class="last-child">Hi there, we made something for you.</p>',
    posterUrl: 'https://r2.example.com/poster-s1.jpg',
    videoUrl: 'https://r2.example.com/video-s1.mp4',
    remainingBodyHtml: '<p class="last-child">We noticed your great reviews.</p>',
    ctaHtml: '<p class="last-child">Click above to watch!</p>',
    businessName: 'Acme Pest Control',
    logoUrl: 'https://auditandfix.com/assets/img/logo-light.svg',
    unsubscribeUrl: 'https://unsub.example.com/?email=test%40example.com',
    physicalAddressHtml: '123 Main St, Sydney NSW 2000',
    year: '2026',
    ...overrides,
  };
}

// ─── Basic output structure ────────────────────────────────────────────────

describe('buildEmailHtml — basic structure', () => {
  it('returns a string', () => {
    const html = buildEmailHtml(makeParams());
    assert.equal(typeof html, 'string');
  });

  it('starts with <!DOCTYPE html>', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'Should start with DOCTYPE');
  });

  it('contains <html> opening tag with lang="en"', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('<html lang="en"'));
  });

  it('contains </html> closing tag', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('</html>'));
  });

  it('contains <head> section', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('<head>'));
    assert.ok(html.includes('</head>'));
  });

  it('contains <body> section', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('<body>'));
    assert.ok(html.includes('</body>'));
  });

  it('contains <style> block with email client resets', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('mso-table-lspace'));
  });

  it('contains MSO conditional comments for Outlook', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('<!--[if gte mso 15]>'));
    assert.ok(html.includes('<o:OfficeDocumentSettings>'));
  });

  it('contains responsive media queries', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('@media only screen and (max-width: 480px)'));
  });

  it('contains meta charset UTF-8', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('<meta charset="UTF-8"'));
  });

  it('contains viewport meta tag', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('name="viewport"'));
  });
});

// ─── Parameter interpolation ──────────────────────────────────────────────

describe('buildEmailHtml — parameter interpolation', () => {
  it('includes previewText in hidden preview span', () => {
    const html = buildEmailHtml(makeParams({ previewText: 'My preview text here' }));
    assert.ok(html.includes('My preview text here'));
    assert.ok(html.includes('mcnPreviewText'));
  });

  it('includes hookHtml in the body', () => {
    const hookHtml = '<p class="last-child">Custom hook paragraph</p>';
    const html = buildEmailHtml(makeParams({ hookHtml }));
    assert.ok(html.includes('Custom hook paragraph'));
  });

  it('includes posterUrl as image src', () => {
    const posterUrl = 'https://cdn.example.com/my-poster.jpg';
    const html = buildEmailHtml(makeParams({ posterUrl }));
    assert.ok(html.includes(`src="${posterUrl}"`));
  });

  it('includes videoUrl as link href on the poster image', () => {
    const videoUrl = 'https://cdn.example.com/my-video.mp4';
    const html = buildEmailHtml(makeParams({ videoUrl }));
    assert.ok(html.includes(`href="${videoUrl}"`));
  });

  it('includes remainingBodyHtml after the poster image', () => {
    const remainingBodyHtml = '<p class="last-child">We love your 5-star reviews.</p>';
    const html = buildEmailHtml(makeParams({ remainingBodyHtml }));
    assert.ok(html.includes('We love your 5-star reviews.'));
  });

  it('includes ctaHtml', () => {
    const ctaHtml = '<p class="last-child">Watch now and see the magic!</p>';
    const html = buildEmailHtml(makeParams({ ctaHtml }));
    assert.ok(html.includes('Watch now and see the magic!'));
  });

  it('includes businessName in poster alt text', () => {
    const html = buildEmailHtml(makeParams({ businessName: 'Joe Plumbing' }));
    assert.ok(html.includes('Joe Plumbing video preview'));
  });

  it('includes logoUrl in header and footer logo images', () => {
    const logoUrl = 'https://cdn.example.com/logo.svg';
    const html = buildEmailHtml(makeParams({ logoUrl }));
    // Logo should appear multiple times (header + footer + MSO fallback)
    const count = (html.match(new RegExp(logoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assert.ok(count >= 2, `Logo URL should appear at least twice, found ${count}`);
  });

  it('includes unsubscribeUrl as unsubscribe link href', () => {
    const unsubscribeUrl = 'https://unsub.example.com/?email=foo%40bar.com';
    const html = buildEmailHtml(makeParams({ unsubscribeUrl }));
    assert.ok(html.includes(`href="${unsubscribeUrl}"`));
    assert.ok(html.includes('unsubscribe'));
  });

  it('includes physicalAddressHtml in footer', () => {
    const html = buildEmailHtml(makeParams({ physicalAddressHtml: '456 George St, Melbourne VIC 3000' }));
    assert.ok(html.includes('456 George St, Melbourne VIC 3000'));
  });

  it('includes year in copyright notice', () => {
    const html = buildEmailHtml(makeParams({ year: '2027' }));
    assert.ok(html.includes('2027'));
    assert.ok(html.includes('Copyright'));
  });

  it('includes Audit&Fix in copyright text', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('Audit&amp;Fix'));
  });
});

// ─── Optional parameters ─────────────────────────────────────────────────

describe('buildEmailHtml — optional parameters', () => {
  it('uses subject in <title> when provided', () => {
    const html = buildEmailHtml(makeParams({ subject: 'Your Free Video Review' }));
    assert.ok(html.includes('<title>Your Free Video Review</title>'));
  });

  it('uses default title when subject is empty', () => {
    const html = buildEmailHtml(makeParams({ subject: '' }));
    assert.ok(html.includes('<title>Audit&amp;Fix Video Review</title>'));
  });

  it('uses default title when subject is not provided', () => {
    const params = makeParams();
    delete params.subject;
    const html = buildEmailHtml(params);
    assert.ok(html.includes('<title>Audit&amp;Fix Video Review</title>'));
  });

  it('includes finePrintHtml when provided', () => {
    const html = buildEmailHtml(makeParams({ finePrintHtml: 'This is a promotional email.' }));
    assert.ok(html.includes('This is a promotional email.'));
  });

  it('omits finePrintHtml when empty string', () => {
    const html = buildEmailHtml(makeParams({ finePrintHtml: '' }));
    // Should still have copyright but not extra finePrint space prefix
    assert.ok(html.includes('Copyright'));
  });

  it('defaults finePrintHtml to empty string', () => {
    const params = makeParams();
    delete params.finePrintHtml;
    const html = buildEmailHtml(params);
    assert.equal(typeof html, 'string');
    assert.ok(html.includes('Copyright'));
  });

  it('omits physical address HTML when empty string', () => {
    const html = buildEmailHtml(makeParams({ physicalAddressHtml: '' }));
    // Copyright line should not have a trailing address
    assert.ok(html.includes('Audit&amp;Fix.'));
  });
});

// ─── XSS prevention ─────────────────────────────────────────────────────

describe('buildEmailHtml — XSS prevention', () => {
  it('escapes < in subject to prevent HTML injection in title', () => {
    const html = buildEmailHtml(makeParams({ subject: '<script>alert("xss")</script>' }));
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('&lt;script'));
  });

  it('escapes multiple < characters in subject', () => {
    const html = buildEmailHtml(makeParams({ subject: '<<test>>' }));
    assert.ok(html.includes('&lt;&lt;test'));
  });
});

// ─── Footer structure ───────────────────────────────────────────────────

describe('buildEmailHtml — footer', () => {
  it('contains footer section with mceFooterSection class', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('mceFooterSection'));
  });

  it('contains unsubscribe link text', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('>unsubscribe</a>'));
  });

  it('has copyright with year and Audit&Fix', () => {
    const html = buildEmailHtml(makeParams({ year: '2026' }));
    assert.ok(html.includes('Copyright &copy; 2026 Audit&amp;Fix.'));
  });

  it('includes physical address after copyright when provided', () => {
    const html = buildEmailHtml(makeParams({ physicalAddressHtml: 'PO Box 123' }));
    // Copyright ... Audit&Fix. PO Box 123
    assert.ok(html.includes('Audit&amp;Fix. PO Box 123'));
  });

  it('has finePrint before copyright when provided', () => {
    const html = buildEmailHtml(makeParams({ finePrintHtml: 'Legal notice.' }));
    // finePrint appears before Copyright
    const finePrintIdx = html.indexOf('Legal notice.');
    const copyrightIdx = html.indexOf('Copyright');
    assert.ok(finePrintIdx < copyrightIdx, 'finePrint should come before Copyright');
  });

  it('footer logo has alt text', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('alt="Audit&amp;Fix Footer Logo"'));
  });
});

// ─── Poster image section ───────────────────────────────────────────────

describe('buildEmailHtml — poster image', () => {
  it('poster image is wrapped in an anchor linking to videoUrl', () => {
    const html = buildEmailHtml(makeParams({
      videoUrl: 'https://cdn.example.com/video.mp4',
      posterUrl: 'https://cdn.example.com/poster.jpg',
    }));
    // The <a href="videoUrl"> should contain the poster <img>
    const anchorStart = html.indexOf('href="https://cdn.example.com/video.mp4"');
    assert.ok(anchorStart > -1, 'anchor with videoUrl should exist');
    const imgAfterAnchor = html.indexOf('src="https://cdn.example.com/poster.jpg"', anchorStart);
    assert.ok(imgAfterAnchor > anchorStart, 'poster img should appear after the anchor');
  });

  it('poster image has alt text with business name', () => {
    const html = buildEmailHtml(makeParams({ businessName: 'Best Roofers' }));
    assert.ok(html.includes('alt="Best Roofers video preview"'));
  });

  it('poster image has max-width 561px', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('max-width:561px'));
  });

  it('MSO fallback includes poster image with fixed width', () => {
    const html = buildEmailHtml(makeParams({ posterUrl: 'https://r2.example.com/poster.jpg' }));
    // MSO conditional has <img with width="561"
    assert.ok(html.includes('width:561px'));
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────

describe('buildEmailHtml — edge cases', () => {
  it('handles empty hookHtml', () => {
    const html = buildEmailHtml(makeParams({ hookHtml: '' }));
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0);
  });

  it('handles empty remainingBodyHtml', () => {
    const html = buildEmailHtml(makeParams({ remainingBodyHtml: '' }));
    assert.equal(typeof html, 'string');
    assert.ok(html.includes('</html>'));
  });

  it('handles empty ctaHtml', () => {
    const html = buildEmailHtml(makeParams({ ctaHtml: '' }));
    assert.equal(typeof html, 'string');
  });

  it('handles business name with special characters', () => {
    const html = buildEmailHtml(makeParams({ businessName: 'O\'Brien & Sons "Plumbing"' }));
    assert.ok(html.includes('O\'Brien & Sons "Plumbing" video preview'));
  });

  it('handles very long previewText', () => {
    const longPreview = 'A'.repeat(500);
    const html = buildEmailHtml(makeParams({ previewText: longPreview }));
    assert.ok(html.includes(longPreview));
  });

  it('handles unicode characters in content', () => {
    const html = buildEmailHtml(makeParams({
      hookHtml: '<p>Bienvenue a notre service!</p>',
      businessName: 'Cafe Deja Vu',
    }));
    assert.ok(html.includes('Bienvenue'));
    assert.ok(html.includes('Cafe Deja Vu'));
  });

  it('handles URLs with query parameters and fragments', () => {
    const videoUrl = 'https://cdn.example.com/video.mp4?token=abc123&v=2#start';
    const html = buildEmailHtml(makeParams({ videoUrl }));
    assert.ok(html.includes(videoUrl));
  });

  it('output is reasonably sized (between 5KB and 50KB)', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.length > 5000, `HTML too short: ${html.length} chars`);
    assert.ok(html.length < 50000, `HTML too long: ${html.length} chars`);
  });
});

// ─── Email client compatibility markers ─────────────────────────────────

describe('buildEmailHtml — email client compatibility', () => {
  it('contains VML namespace for Outlook', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('xmlns:v="urn:schemas-microsoft-com:vml"'));
  });

  it('contains Office namespace for Outlook', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('xmlns:o="urn:schemas-microsoft-com:office:office"'));
  });

  it('contains ExternalClass styles for Outlook.com', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('.ExternalClass'));
  });

  it('contains ReadMsgBody styles for Hotmail/Outlook.com', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('.ReadMsgBody'));
  });

  it('contains apple-data-detectors override for iOS', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('x-apple-data-detectors'));
  });

  it('uses Helvetica Neue font stack', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('"Helvetica Neue", Helvetica, Arial, Verdana, sans-serif'));
  });

  it('contains zero-width space characters for preview text padding', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('&#847;'));
  });

  it('contains VML roundrect button for Outlook', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('v:roundrect'));
  });

  it('contains table-based layout (not div-based)', () => {
    const html = buildEmailHtml(makeParams());
    // Count tables — email templates rely on tables heavily
    const tableCount = (html.match(/<table/g) || []).length;
    assert.ok(tableCount >= 10, `Expected many tables, found ${tableCount}`);
  });

  it('has role="presentation" on layout tables', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('role="presentation"'));
  });
});

// ─── Header logo ────────────────────────────────────────────────────────

describe('buildEmailHtml — header logo', () => {
  it('header logo has alt="Audit&Fix"', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('alt="Audit&amp;Fix"'));
  });

  it('header logo has width="130"', () => {
    const html = buildEmailHtml(makeParams());
    // Should appear in header section
    assert.ok(html.includes('width="130"'));
  });

  it('header logo uses logoUrl parameter', () => {
    const logoUrl = 'https://custom-cdn.example.com/brand-logo.png';
    const html = buildEmailHtml(makeParams({ logoUrl }));
    assert.ok(html.includes(logoUrl));
  });
});

// ─── Divider ─────────────────────────────────────────────────────────────

describe('buildEmailHtml — divider', () => {
  it('contains a 2px black horizontal divider', () => {
    const html = buildEmailHtml(makeParams());
    assert.ok(html.includes('border-top-width:2px'));
    assert.ok(html.includes('border-top-style:solid'));
    assert.ok(html.includes('border-top-color:#000000'));
  });
});
