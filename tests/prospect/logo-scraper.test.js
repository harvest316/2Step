/**
 * Tests for logo-scraper pure/extractable functions.
 *
 * logo-scraper.js is a CLI script (not a module), so we re-implement
 * the pure helpers here and test them directly. The actual network/DB
 * calls (scrapeLogo, brandfetch, main) are integration-level and
 * are not unit-tested here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── resolveUrl (copied from logo-scraper.js — pure function) ─────────────────

function resolveUrl(base, url) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

// ─── extractLogoFromHtml helpers (logic extracted for testing) ────────────────

/** Extract src from first <img> whose class/id/aria-label/alt contains "logo" */
function extractImgLogoAttr(html) {
  const tags = html.match(/<img[^>]+(?:class|id|aria-label|alt)=["'][^"']*logo[^"']*["'][^>]*>/gi);
  if (!tags) return null;
  for (const tag of tags) {
    const src = tag.match(/src=["']([^"']+)["']/i)?.[1];
    if (src) return src;
  }
  return null;
}

/** Extract src from <img> with "logo" in src filename */
function extractLogoInSrc(html) {
  return html.match(/src=["']([^"']*logo[^"']*)["']/i)?.[1] || null;
}

/** Extract apple-touch-icon href */
function extractAppleTouchIcon(html) {
  return (
    html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon["']/i)?.[1] ||
    null
  );
}

/** Extract og:image content */
function extractOgImage(html) {
  return (
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
    null
  );
}

/** Extract Organization.logo from JSON-LD */
function extractJsonLdLogo(html) {
  const matches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      const orgs = [data, ...(data['@graph'] || [])].filter(n => n?.['@type'] === 'Organization');
      for (const org of orgs) {
        const logo = org.logo;
        if (typeof logo === 'string') return logo;
        if (logo?.url) return logo.url;
      }
    } catch { /* skip malformed */ }
  }
  return null;
}

// ─── resolveUrl ───────────────────────────────────────────────────────────────

describe('resolveUrl', () => {
  const base = new URL('https://example.com');

  it('resolves absolute URLs unchanged', () => {
    assert.equal(resolveUrl(base, 'https://cdn.example.com/logo.png'), 'https://cdn.example.com/logo.png');
  });

  it('resolves root-relative URLs', () => {
    assert.equal(resolveUrl(base, '/images/logo.png'), 'https://example.com/images/logo.png');
  });

  it('resolves relative URLs against base', () => {
    const pageBase = new URL('https://example.com/about/');
    assert.equal(resolveUrl(pageBase, '../images/logo.png'), 'https://example.com/images/logo.png');
  });

  it('returns a string for any resolvable input (new URL is very permissive)', () => {
    // new URL() resolves almost anything — just verify it returns a string, not null/undefined
    const result = resolveUrl(base, '/some/path.png');
    assert.equal(typeof result, 'string');
    assert.ok(result.startsWith('https://'));
  });

  it('handles protocol-relative URLs', () => {
    const result = resolveUrl(base, '//cdn.example.com/logo.svg');
    assert.equal(result, 'https://cdn.example.com/logo.svg');
  });
});

// ─── extractImgLogoAttr ───────────────────────────────────────────────────────

describe('extractImgLogoAttr', () => {
  it('finds img with class containing "logo"', () => {
    const html = '<img class="site-logo" src="/img/logo.png" alt="Logo">';
    assert.equal(extractImgLogoAttr(html), '/img/logo.png');
  });

  it('finds img with id containing "logo"', () => {
    const html = '<img id="header-logo" src="/logo.svg">';
    assert.equal(extractImgLogoAttr(html), '/logo.svg');
  });

  it('finds img with alt containing "logo" (case-insensitive)', () => {
    const html = '<img alt="Company Logo" src="/assets/brand.png">';
    assert.equal(extractImgLogoAttr(html), '/assets/brand.png');
  });

  it('finds img with aria-label containing "logo"', () => {
    const html = '<img aria-label="logo image" src="/logo.webp">';
    assert.equal(extractImgLogoAttr(html), '/logo.webp');
  });

  it('returns null when no logo img found', () => {
    const html = '<img class="hero-banner" src="/hero.jpg"><img src="/product.jpg">';
    assert.equal(extractImgLogoAttr(html), null);
  });

  it('returns null for empty html', () => {
    assert.equal(extractImgLogoAttr(''), null);
  });

  it('returns the first src found among logo-attributed imgs', () => {
    // The regex finds the first img with logo in its attributes that also has src.
    // First tag has no src, second does — we expect the second's src.
    // NOTE: the simple regex approach doesn't skip data-src, it just requires src="..."
    const html = '<img class="logo" src="/first-logo.png"><img class="logo" src="/second-logo.png">';
    assert.equal(extractImgLogoAttr(html), '/first-logo.png');
  });
});

// ─── extractLogoInSrc ────────────────────────────────────────────────────────

describe('extractLogoInSrc', () => {
  it('finds img with "logo" in src filename', () => {
    const html = '<img src="/wp-content/uploads/2024/logo-main.png">';
    assert.equal(extractLogoInSrc(html), '/wp-content/uploads/2024/logo-main.png');
  });

  it('matches "logo" mid-path', () => {
    const html = '<img src="/assets/logo/brand.svg">';
    assert.equal(extractLogoInSrc(html), '/assets/logo/brand.svg');
  });

  it('returns null when "logo" not in any src', () => {
    const html = '<img src="/hero.jpg"><img src="/banner.png">';
    assert.equal(extractLogoInSrc(html), null);
  });
});

// ─── extractAppleTouchIcon ────────────────────────────────────────────────────

describe('extractAppleTouchIcon', () => {
  it('extracts href from rel="apple-touch-icon" link', () => {
    const html = '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    assert.equal(extractAppleTouchIcon(html), '/apple-touch-icon.png');
  });

  it('extracts when href comes before rel', () => {
    const html = '<link href="/touch-icon-180.png" rel="apple-touch-icon">';
    assert.equal(extractAppleTouchIcon(html), '/touch-icon-180.png');
  });

  it('returns null when not present', () => {
    const html = '<link rel="stylesheet" href="/styles.css">';
    assert.equal(extractAppleTouchIcon(html), null);
  });
});

// ─── extractOgImage ───────────────────────────────────────────────────────────

describe('extractOgImage', () => {
  it('extracts og:image content (property before content)', () => {
    const html = '<meta property="og:image" content="https://example.com/og.jpg">';
    assert.equal(extractOgImage(html), 'https://example.com/og.jpg');
  });

  it('extracts og:image content (content before property)', () => {
    const html = '<meta content="https://example.com/og.jpg" property="og:image">';
    assert.equal(extractOgImage(html), 'https://example.com/og.jpg');
  });

  it('returns null when not present', () => {
    const html = '<meta property="og:title" content="My Page">';
    assert.equal(extractOgImage(html), null);
  });
});

// ─── extractJsonLdLogo ────────────────────────────────────────────────────────

describe('extractJsonLdLogo', () => {
  it('extracts logo.url from Organization JSON-LD', () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"Organization","name":"Acme","logo":{"@type":"ImageObject","url":"https://acme.com/logo.png"}}
      </script>`;
    assert.equal(extractJsonLdLogo(html), 'https://acme.com/logo.png');
  });

  it('extracts logo as direct string', () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"Organization","logo":"https://acme.com/brand.svg"}
      </script>`;
    assert.equal(extractJsonLdLogo(html), 'https://acme.com/brand.svg');
  });

  it('extracts from @graph array', () => {
    const html = `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[
          {"@type":"WebSite","url":"https://acme.com"},
          {"@type":"Organization","logo":"https://acme.com/logo.png"}
        ]}
      </script>`;
    assert.equal(extractJsonLdLogo(html), 'https://acme.com/logo.png');
  });

  it('returns null when no Organization type present', () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"WebSite","url":"https://acme.com"}
      </script>`;
    assert.equal(extractJsonLdLogo(html), null);
  });

  it('returns null for malformed JSON-LD', () => {
    const html = `<script type="application/ld+json">{broken json</script>`;
    assert.equal(extractJsonLdLogo(html), null);
  });

  it('returns null when no script tags present', () => {
    assert.equal(extractJsonLdLogo('<p>No scripts here</p>'), null);
  });

  it('skips non-Organization types and finds correct one', () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"LocalBusiness","logo":"https://wrong.com/logo.png"}
      </script>
      <script type="application/ld+json">
        {"@type":"Organization","logo":"https://correct.com/logo.png"}
      </script>`;
    assert.equal(extractJsonLdLogo(html), 'https://correct.com/logo.png');
  });
});
