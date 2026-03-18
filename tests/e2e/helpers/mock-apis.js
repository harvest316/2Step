/**
 * Mock API response factories for E2E tests.
 *
 * These replace the real Outscraper, Resend, Twilio, and ElevenLabs calls so
 * tests run entirely in-process without network access.
 *
 * Each function returns data that exactly matches the shape of the real API's
 * response, allowing the stage functions to process them without modification.
 */

// ─── Outscraper mocks ─────────────────────────────────────────────────────────

/**
 * Return a fake Outscraper Maps search result array.
 * Matches the shape consumed by reviews.js `searchBusinesses()`.
 *
 * @param {string} keyword
 * @param {string} location
 * @param {number} [count=2]
 * @returns {Object[]}
 */
export function mockOutscraperSearch(keyword, location, count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    name:           `Test Business ${i + 1}`,
    rating:         4.8,
    reviews:        150 + i * 10,
    reviews_count:  150 + i * 10,
    place_id:       `ChIJ_mock_${i + 1}`,
    google_id:      `ChIJ_mock_${i + 1}`,
    site:           `https://testbiz${i + 1}.com`,
    website:        `https://testbiz${i + 1}.com`,
    phone:          `+6140000000${i + 1}`,
    email_1:        `owner@testbiz${i + 1}.com`,
    city:           location,
    state:          'NSW',
    google_maps_url:`https://maps.google.com/?q=ChIJ_mock_${i + 1}`,
    social_media:   [],
  }));
}

/**
 * Return a fake Outscraper Reviews API result for a single business.
 * Matches the shape consumed by reviews.js `fetchMatchingReview()`.
 *
 * @param {string} placeId
 * @param {Object} [options]
 * @param {string} [options.reviewText]  - Override review body
 * @param {number} [options.rating]      - Override star rating (default 5)
 * @returns {Object}  Shape: { reviews_data: [...] }
 */
export function mockOutscraperReviews(placeId, options = {}) {
  const reviewText = options.reviewText
    ?? 'Had a terrible termite problem and they came out same day. Did a thorough inspection and treatment. Professional service from start to finish. Highly recommend for any pest issues.';

  return {
    reviews_data: [
      {
        review_rating: options.rating ?? 5,
        review_text:   reviewText,
        author_title:  'Jane Smith',
        author_name:   'Jane Smith',
      },
    ],
  };
}

/**
 * Return a fake Outscraper API response that simulates an immediate (non-async)
 * search result — data is returned directly rather than as a pending job.
 *
 * @param {Object[]} businesses  - Array from mockOutscraperSearch()
 * @returns {Object}  Shape matches Outscraper's synchronous /maps/search-v3 response.
 */
export function mockOutscraperSearchResponse(businesses) {
  return {
    status: 'Success',
    data: [businesses],
  };
}

/**
 * Return a fake Outscraper review response that wraps a single business result.
 *
 * @param {Object} reviewsData  - from mockOutscraperReviews()
 * @returns {Object}  Shape matches Outscraper's synchronous /maps/reviews-v3 response.
 */
export function mockOutscraperReviewResponse(reviewsData) {
  return {
    status: 'Success',
    data:   [[reviewsData]],
  };
}

// ─── Resend mocks ─────────────────────────────────────────────────────────────

/**
 * Return a successful Resend send response.
 *
 * @returns {{ data: { id: string }, error: null }}
 */
export function mockResendSend() {
  return {
    data:  { id: `mock_resend_${Date.now()}_${Math.random().toString(36).slice(2)}` },
    error: null,
  };
}

/**
 * Return a failed Resend send response.
 *
 * @param {string} [message]
 * @returns {{ data: null, error: { message: string } }}
 */
export function mockResendError(message = 'Resend API error') {
  return { data: null, error: { message } };
}

// ─── Twilio mocks ─────────────────────────────────────────────────────────────

/**
 * Return a successful Twilio message.create() result.
 *
 * @returns {{ sid: string, status: string }}
 */
export function mockTwilioSend() {
  return {
    sid:    `SM_mock_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    status: 'sent',
  };
}

/**
 * Return a fake Twilio client that resolves mockTwilioSend() when
 * messages.create() is called.
 *
 * @param {Object} [result]  - Override the resolved value.
 * @returns {{ messages: { create: Function } }}
 */
export function mockTwilioClient(result) {
  return {
    messages: {
      create: async () => result ?? mockTwilioSend(),
    },
  };
}

// ─── Resend client mock ───────────────────────────────────────────────────────

/**
 * Return a fake Resend client whose emails.send() resolves with mockResendSend().
 *
 * @param {Object} [result]  - Override the resolved value.
 * @returns {{ emails: { send: Function } }}
 */
export function mockResendClient(result) {
  return {
    emails: {
      send: async () => result ?? mockResendSend(),
    },
  };
}

// ─── ElevenLabs mock ─────────────────────────────────────────────────────────

/**
 * Return a fake audio buffer (ElevenLabs TTS output).
 *
 * @param {number} [size=1024]
 * @returns {Buffer}
 */
export function mockElevenLabsTts(size = 1024) {
  return Buffer.alloc(size);
}

// ─── Stage function stub factory ──────────────────────────────────────────────

/**
 * Build a no-op stage function that immediately returns a stats object.
 * Useful for the pipeline integration test where we want to verify the
 * pipeline wires up stages without actually running them.
 *
 * @param {Object} [returnValue]
 * @returns {Function}
 */
export function noopStage(returnValue = {}) {
  return async () => returnValue;
}
