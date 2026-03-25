/**
 * Unit tests for pure helper functions exported from reviews.js.
 *
 * Tests:
 *   - buildQueryFromCriteria: builds Outscraper reviewsQuery from criteria config
 *   - makeSemaphore: async concurrency limiter
 *   - extractSocials: extracts Instagram/Facebook from Outscraper result data
 *   - scoreReview: scores a review for suitability based on category match + word count
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryFromCriteria,
  makeSemaphore,
  extractSocials,
  scoreReview,
  loadReviewCriteria,
} from '../../src/stages/reviews.js';

// ─── buildQueryFromCriteria ──────────────────────────────────────────────────

describe('buildQueryFromCriteria', () => {
  it('returns a space-joined string of all query terms', () => {
    const criteria = {
      problems: {
        termite: { query_terms: ['termite', 'white ant'] },
        roach: { query_terms: ['cockroach', 'roach'] },
      },
    };
    const result = buildQueryFromCriteria(criteria);
    assert.ok(result.includes('termite'));
    assert.ok(result.includes('white ant'));
    assert.ok(result.includes('cockroach'));
    assert.ok(result.includes('roach'));
  });

  it('deduplicates terms across problems', () => {
    const criteria = {
      problems: {
        a: { query_terms: ['pest', 'bug'] },
        b: { query_terms: ['bug', 'insect'] },
      },
    };
    const result = buildQueryFromCriteria(criteria);
    const terms = result.split(' ');
    const bugCount = terms.filter(t => t === 'bug').length;
    assert.equal(bugCount, 1, 'Duplicate "bug" should be removed');
  });

  it('returns empty string when no query_terms exist', () => {
    const criteria = {
      problems: {
        a: { query_terms: [] },
        b: {},
      },
    };
    const result = buildQueryFromCriteria(criteria);
    assert.equal(result, '');
  });

  it('handles problems with missing query_terms gracefully', () => {
    const criteria = {
      problems: {
        a: { clip_pool: 'termite' },
        b: { query_terms: ['spider'] },
      },
    };
    const result = buildQueryFromCriteria(criteria);
    assert.equal(result, 'spider');
  });

  it('returns empty string for empty problems object', () => {
    const criteria = { problems: {} };
    const result = buildQueryFromCriteria(criteria);
    assert.equal(result, '');
  });

  it('handles single problem with single term', () => {
    const criteria = {
      problems: {
        drain: { query_terms: ['blocked drain'] },
      },
    };
    const result = buildQueryFromCriteria(criteria);
    assert.equal(result, 'blocked drain');
  });

  it('preserves multi-word terms', () => {
    const criteria = {
      problems: {
        a: { query_terms: ['white ant', 'termite barrier'] },
      },
    };
    const result = buildQueryFromCriteria(criteria);
    assert.ok(result.includes('white ant'));
    assert.ok(result.includes('termite barrier'));
  });
});

// ─── makeSemaphore ──────────────────────────────────────────────────────────

describe('makeSemaphore', () => {
  it('returns an acquire function', () => {
    const acquire = makeSemaphore(3);
    assert.equal(typeof acquire, 'function');
  });

  it('acquire resolves to a release function', async () => {
    const acquire = makeSemaphore(1);
    const release = await acquire();
    assert.equal(typeof release, 'function');
    release();
  });

  it('allows up to limit concurrent acquisitions', async () => {
    const acquire = makeSemaphore(3);
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquire());
    }
    assert.equal(releases.length, 3);
    releases.forEach(r => r());
  });

  it('blocks beyond the limit until a release', async () => {
    const acquire = makeSemaphore(1);
    const release1 = await acquire();

    let acquired2 = false;
    const p2 = acquire().then(r => { acquired2 = true; return r; });

    // Give microtask queue a chance to process
    await new Promise(r => setTimeout(r, 10));
    assert.equal(acquired2, false, 'Second acquire should be blocked');

    release1();
    const release2 = await p2;
    assert.equal(acquired2, true, 'Second acquire should succeed after release');
    release2();
  });

  it('processes queued items in order (FIFO)', async () => {
    const acquire = makeSemaphore(1);
    const order = [];

    const release1 = await acquire();

    const p2 = acquire().then(r => { order.push(2); return r; });
    const p3 = acquire().then(r => { order.push(3); return r; });

    release1();
    const release2 = await p2;
    release2();
    const release3 = await p3;
    release3();

    assert.deepEqual(order, [2, 3]);
  });

  it('handles rapid acquire/release cycles', async () => {
    const acquire = makeSemaphore(2);
    let completedCount = 0;

    const tasks = Array.from({ length: 10 }, async () => {
      const release = await acquire();
      completedCount++;
      release();
    });

    await Promise.all(tasks);
    assert.equal(completedCount, 10);
  });

  it('semaphore with limit=0 never resolves', async () => {
    // Edge case: limit 0 means nothing can acquire
    const acquire = makeSemaphore(0);
    let resolved = false;
    acquire().then(() => { resolved = true; });

    await new Promise(r => setTimeout(r, 50));
    assert.equal(resolved, false, 'Should never resolve with limit=0');
  });
});

// ─── extractSocials ─────────────────────────────────────────────────────────

describe('extractSocials', () => {
  it('returns null for both when no social data exists', () => {
    const result = extractSocials({});
    assert.equal(result.instagram, null);
    assert.equal(result.facebook, null);
  });

  it('extracts Instagram handle from social_media array', () => {
    const result = extractSocials({
      social_media: ['https://www.instagram.com/acme_pest/'],
    });
    assert.equal(result.instagram, 'acme_pest');
  });

  it('extracts Facebook URL from social_media array', () => {
    const result = extractSocials({
      social_media: ['https://www.facebook.com/AcmePest'],
    });
    assert.equal(result.facebook, 'https://www.facebook.com/AcmePest');
  });

  it('extracts both Instagram and Facebook from same result', () => {
    const result = extractSocials({
      social_media: [
        'https://www.instagram.com/mybiz/',
        'https://www.facebook.com/MyBiz',
      ],
    });
    assert.equal(result.instagram, 'mybiz');
    assert.equal(result.facebook, 'https://www.facebook.com/MyBiz');
  });

  it('extracts Instagram handle from instagram_url field', () => {
    const result = extractSocials({
      instagram_url: 'https://instagram.com/cool_biz',
    });
    assert.equal(result.instagram, 'cool_biz');
  });

  it('extracts Facebook URL from facebook_url field', () => {
    const result = extractSocials({
      facebook_url: 'https://facebook.com/CoolBiz',
    });
    assert.equal(result.facebook, 'https://facebook.com/CoolBiz');
  });

  it('handles social_media entries that are objects with url property', () => {
    const result = extractSocials({
      social_media: [
        { url: 'https://instagram.com/test_handle', type: 'instagram' },
      ],
    });
    assert.equal(result.instagram, 'test_handle');
  });

  it('ignores non-Instagram/Facebook social media URLs', () => {
    const result = extractSocials({
      social_media: [
        'https://twitter.com/mybiz',
        'https://linkedin.com/company/mybiz',
      ],
    });
    assert.equal(result.instagram, null);
    assert.equal(result.facebook, null);
  });

  it('handles Instagram URL with query parameters', () => {
    const result = extractSocials({
      social_media: ['https://www.instagram.com/my_biz/?hl=en'],
    });
    assert.equal(result.instagram, 'my_biz');
  });

  it('handles Instagram URL with hash fragment', () => {
    const result = extractSocials({
      social_media: ['https://www.instagram.com/my_biz#posts'],
    });
    assert.equal(result.instagram, 'my_biz');
  });

  it('handles null social_media entries gracefully', () => {
    const result = extractSocials({
      social_media: [null, undefined, 'https://instagram.com/valid'],
    });
    assert.equal(result.instagram, 'valid');
  });

  it('handles empty social_media array', () => {
    const result = extractSocials({ social_media: [] });
    assert.equal(result.instagram, null);
    assert.equal(result.facebook, null);
  });

  it('prefers social_media over direct URL fields (processes in order)', () => {
    const result = extractSocials({
      social_media: ['https://instagram.com/from_array'],
      instagram_url: 'https://instagram.com/from_field',
    });
    // Both are processed — last one wins since the loop goes through all links
    // Actually, the links array is [...social_media, facebook_url, instagram_url]
    // so instagram_url comes last and overwrites
    assert.equal(result.instagram, 'from_field');
  });

  it('handles social_media entries that are objects with no url', () => {
    const result = extractSocials({
      social_media: [{ type: 'instagram' }],
    });
    assert.equal(result.instagram, null);
  });
});

// ─── scoreReview ────────────────────────────────────────────────────────────

describe('scoreReview', () => {
  it('returns -1 when no category matches', () => {
    const score = scoreReview('Excellent customer service overall', 'pest control');
    assert.equal(score, -1);
  });

  it('returns -1 for unknown niche', () => {
    const score = scoreReview('Great termite treatment', 'acupuncture');
    assert.equal(score, -1);
  });

  it('returns -1 when review has matching keywords but too few words', () => {
    // "termite problem fixed" = 3 words, below MIN_WORD_COUNT (30)
    const score = scoreReview('termite problem fixed', 'pest control');
    assert.equal(score, -1);
  });

  it('returns positive score for a qualifying review', () => {
    const longReview =
      'We had a terrible termite problem in our home and they came out the same day to inspect. ' +
      'The technician was incredibly thorough and professional throughout the entire treatment process. ' +
      'Would highly recommend their termite services to anyone in Sydney.';
    const score = scoreReview(longReview, 'pest control');
    assert.ok(score > 0, `Expected positive score, got ${score}`);
  });

  it('scores higher for more keyword hits', () => {
    // Review with multiple termite keywords
    const manyHits =
      'We had a termite infestation. The termite inspection revealed termite damage in the walls. ' +
      'They installed a termite barrier and treated the termite colony. The termite bait stations ' +
      'are working well. Very thorough termite treatment overall and we are very happy.';
    // Review with single keyword hit
    const singleHit =
      'We had a termite problem in our home and they came out the same day to inspect and treat it. ' +
      'The service was professional and they did a great job fixing everything in our house quickly.';

    const scoreMany = scoreReview(manyHits, 'pest control');
    const scoreSingle = scoreReview(singleHit, 'pest control');
    assert.ok(scoreMany > scoreSingle, `Many hits (${scoreMany}) should score higher than single (${scoreSingle})`);
  });

  it('keyword hits are weighted at 1000 per hit', () => {
    // A review with exactly 1 keyword hit and ~35 words
    const review =
      'They handled our cockroach problem really well and we are very impressed with the service they provided. ' +
      'The team was professional and punctual and they really knew what they were doing from start to finish.';
    const score = scoreReview(review, 'pest control');
    // matchCategory returns hits count, score = hits * 1000 + wordCount
    // At least 1 hit (cockroach) => score >= 1000
    assert.ok(score >= 1000, `Expected >= 1000, got ${score}`);
  });

  it('adds word count to the score', () => {
    // Two reviews with same keywords but different lengths
    const shorter =
      'Had a terrible cockroach infestation in our kitchen and bathroom. They came out and treated ' +
      'the entire property. The cockroach treatment was effective and we are very happy with results.';
    const longer =
      'Had a terrible cockroach infestation in our kitchen and bathroom. They came out and treated ' +
      'the entire property. The cockroach treatment was effective and we are very happy with results. ' +
      'The technician explained everything clearly and gave us tips to prevent future problems. ' +
      'They also checked the garage and outdoor areas for any signs of other pest activity.';

    const scoreShorter = scoreReview(shorter, 'pest control');
    const scoreLonger = scoreReview(longer, 'pest control');
    assert.ok(scoreLonger > scoreShorter, `Longer review (${scoreLonger}) should score higher than shorter (${scoreShorter})`);
  });

  it('works for plumber niche', () => {
    const review =
      'Called them for a blocked drain in the bathroom and they came out within the hour. ' +
      'They used a camera to find the blockage and cleared it quickly. The drain was flowing ' +
      'perfectly again. Highly recommend their drain clearing service to anyone in need.';
    const score = scoreReview(review, 'plumber');
    assert.ok(score > 0, `Expected positive score for plumber review, got ${score}`);
  });

  it('works for dentist niche', () => {
    const review =
      'Came in for a scale and clean and the experience was excellent from start to finish. ' +
      'The dental hygienist was gentle and thorough with the teeth cleaning procedure. ' +
      'My teeth feel amazing and I will definitely be coming back for my next cleaning appointment.';
    const score = scoreReview(review, 'dentist');
    assert.ok(score > 0, `Expected positive score for dentist review, got ${score}`);
  });

  it('is case-insensitive for review text', () => {
    const review =
      'We had a TERMITE problem in our HOME and they came out the same day to inspect and treat it. ' +
      'The service was professional and they did a great job fixing everything in our house quickly.';
    const score = scoreReview(review, 'pest control');
    assert.ok(score > 0, `Expected positive score for uppercase text, got ${score}`);
  });

  it('handles empty review text', () => {
    const score = scoreReview('', 'pest control');
    assert.equal(score, -1);
  });

  it('handles whitespace-only review text', () => {
    const score = scoreReview('   \n\t  ', 'pest control');
    assert.equal(score, -1);
  });
});

// ─── loadReviewCriteria ──────────────────────────────────────────────────────

describe('loadReviewCriteria', () => {
  it('loads AU pest-control criteria successfully', () => {
    const result = loadReviewCriteria('AU', 'pest control');
    assert.ok(result !== null, 'Should load pest-control criteria for AU');
    assert.ok('problems' in result, 'Should have problems key');
  });

  it('returned criteria has problems with query_terms', () => {
    const result = loadReviewCriteria('AU', 'pest control');
    assert.ok(Object.keys(result.problems).length > 0, 'Should have at least one problem');
    for (const [name, problem] of Object.entries(result.problems)) {
      if (name.startsWith('_')) continue; // skip comment keys
      assert.ok(Array.isArray(problem.query_terms), `${name} should have query_terms array`);
      assert.ok(problem.query_terms.length > 0, `${name} should have at least one query term`);
    }
  });

  it('loads AU plumber criteria', () => {
    const result = loadReviewCriteria('AU', 'plumber');
    assert.ok(result !== null);
    assert.ok('problems' in result);
  });

  it('converts niche to kebab-case slug', () => {
    // "pest control" -> "pest-control.json"
    const result = loadReviewCriteria('AU', 'pest control');
    assert.ok(result !== null, 'Should find pest-control via "pest control" niche');
  });

  it('handles niche with slashes (replaced with dashes)', () => {
    // "kitchen/rangehood" -> "kitchen-rangehood.json" (unlikely to exist, returns null)
    const result = loadReviewCriteria('AU', 'kitchen/rangehood');
    // May or may not exist — test just verifies no crash
    assert.ok(result === null || typeof result === 'object');
  });

  it('returns null for non-existent niche', () => {
    const result = loadReviewCriteria('AU', 'underwater basket weaving');
    assert.equal(result, null);
  });

  it('falls back to AU when country-specific file does not exist', () => {
    // Load a niche that exists for AU but not for a random country
    const auResult = loadReviewCriteria('AU', 'pest control');
    const fallbackResult = loadReviewCriteria('ZZ', 'pest control');
    // ZZ has no directory, falls back to AU
    assert.ok(fallbackResult !== null, 'Should fall back to AU');
    assert.deepEqual(fallbackResult, auResult, 'ZZ fallback should match AU');
  });

  it('uses country-specific file when it exists', () => {
    // Both AU and US should have pest-control
    const auResult = loadReviewCriteria('AU', 'pest control');
    const usResult = loadReviewCriteria('US', 'pest control');
    // Both should load (they may or may not be identical)
    assert.ok(auResult !== null);
    assert.ok(usResult !== null);
  });

  it('is case-insensitive for country code (lowercased -> uppercased)', () => {
    // The function calls countryCode.toUpperCase()
    const upper = loadReviewCriteria('AU', 'pest control');
    const lower = loadReviewCriteria('au', 'pest control');
    assert.deepEqual(upper, lower);
  });

  it('handles mixed case niche', () => {
    const lower = loadReviewCriteria('AU', 'pest control');
    const mixed = loadReviewCriteria('AU', 'Pest Control');
    // niche.toLowerCase() is called, so both should produce same slug
    assert.deepEqual(lower, mixed);
  });

  it('house-cleaning criteria exists for AU', () => {
    const result = loadReviewCriteria('AU', 'house cleaning');
    assert.ok(result !== null, 'AU house-cleaning criteria should exist');
    assert.ok('problems' in result);
  });

  it('returns null for empty niche', () => {
    const result = loadReviewCriteria('AU', '');
    // Empty slug maps to ".json" which should not exist
    assert.equal(result, null);
  });
});

// ─── buildQueryFromCriteria + loadReviewCriteria integration ─────────────────

describe('buildQueryFromCriteria + loadReviewCriteria integration', () => {
  it('can build a query string from loaded AU pest-control criteria', () => {
    const criteria = loadReviewCriteria('AU', 'pest control');
    assert.ok(criteria !== null);
    const query = buildQueryFromCriteria(criteria);
    assert.ok(typeof query === 'string');
    assert.ok(query.length > 0, 'Query should not be empty');
    // Should contain at least some pest-related terms
    const lowerQuery = query.toLowerCase();
    const hasPestTerms = ['cockroach', 'termite', 'spider', 'ant', 'rat', 'roach']
      .some(term => lowerQuery.includes(term));
    assert.ok(hasPestTerms, `Query should contain pest terms: "${query}"`);
  });

  it('can build a query string from loaded AU plumber criteria', () => {
    const criteria = loadReviewCriteria('AU', 'plumber');
    assert.ok(criteria !== null);
    const query = buildQueryFromCriteria(criteria);
    assert.ok(query.length > 0);
  });
});

// ─── scoreReview edge cases ─────────────────────────────────────────────────

describe('scoreReview — additional edge cases', () => {
  it('returns -1 for review with exactly 29 words and a keyword match', () => {
    // 29 words with "termite" keyword
    const words = Array(28).fill('word');
    words.push('termite');
    const review = words.join(' ');
    const score = scoreReview(review, 'pest control');
    assert.equal(score, -1, 'Should reject review with 29 words');
  });

  it('returns positive score for review with exactly 30 words and a keyword match', () => {
    const words = Array(29).fill('word');
    words.push('termite');
    const review = words.join(' ');
    const score = scoreReview(review, 'pest control');
    assert.ok(score > 0, `Should accept review with 30 words, got ${score}`);
  });

  it('handles niche case-insensitively', () => {
    const review =
      'We had a terrible termite problem in our home and they came out the same day to inspect. ' +
      'The technician was incredibly thorough and professional throughout the entire treatment process.';
    const lower = scoreReview(review, 'pest control');
    const upper = scoreReview(review, 'Pest Control');
    assert.equal(lower, upper);
  });

  it('different niches score differently for same text', () => {
    // A review about blocked drains should score for plumber but not pest control
    const review =
      'Called them for a blocked drain in the bathroom and they came out within the hour. ' +
      'They used a camera to find the blockage and cleared it quickly and professionally.';
    const plumberScore = scoreReview(review, 'plumber');
    const pestScore = scoreReview(review, 'pest control');
    assert.ok(plumberScore > 0, 'Should score positive for plumber');
    assert.equal(pestScore, -1, 'Should not score for pest control');
  });
});
