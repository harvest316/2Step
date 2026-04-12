/**
 * Portal provisioning — push video/subscription data to auditandfix.app.
 *
 * Called by the video stage after each video is rendered, and by the
 * subscription sync when a site's subscription_status is set to 'active'.
 *
 * Uses the PORTAL_PROVISION_URL / PORTAL_PROVISION_SECRET env vars.
 * Failures are non-fatal: logged as warnings, never throw to the caller.
 *
 * Environment:
 *   PORTAL_PROVISION_URL    — https://auditandfix.app/api?action=provision-product
 *   PORTAL_PROVISION_SECRET — shared bearer token (must match portal .env)
 */

const PROVISION_URL    = process.env.PORTAL_PROVISION_URL;
const PROVISION_SECRET = process.env.PORTAL_PROVISION_SECRET;

/**
 * Provision a video_review product on the customer portal.
 *
 * @param {object} site          — row from twostep.sites (must include email, domain, niche, etc.)
 * @param {object} video
 * @param {string} video.videoHash   — base62 hash for /v/{hash}
 * @param {string} video.videoUrl    — R2 hosted MP4 URL
 * @param {string} video.posterUrl   — R2 hosted poster JPEG URL
 */
export async function provisionVideoReview(site, video) {
  if (!site.email) {
    console.warn('[provision-portal] skipping: site has no email');
    return;
  }
  if (!PROVISION_URL || !PROVISION_SECRET) {
    console.warn('[provision-portal] PORTAL_PROVISION_URL / PORTAL_PROVISION_SECRET not set — skipping');
    return;
  }

  const nicheDisplay = site.niche
    ? site.niche.replace(/\b\w/g, c => c.toUpperCase())
    : '';

  await _post({
    email:        site.email,
    product_type: 'video_review',
    external_ref: video.videoHash,
    label:        site.business_name,
    domain:       site.domain ?? '',
    country_code: site.country_code ?? '',
    status:       'active',
    metadata: {
      hash:          video.videoHash,
      video_url:     video.videoUrl,
      poster_url:    video.posterUrl,
      business_name: site.business_name,
      niche:         site.niche ?? '',
      niche_display: nicheDisplay,
      google_rating: site.google_rating ?? null,
      review_count:  site.review_count  ?? 0,
      city:          site.city          ?? '',
      country_code:  site.country_code  ?? '',
      view_count:    0,
    },
  });
}

/**
 * Provision a video_subscription product on the customer portal.
 *
 * @param {object} site — row from twostep.sites (must include email, subscription_* fields)
 */
export async function provisionSubscription(site) {
  if (!site.email) {
    console.warn('[provision-portal] skipping subscription: site has no email');
    return;
  }
  if (!PROVISION_URL || !PROVISION_SECRET) {
    console.warn('[provision-portal] PORTAL_PROVISION_URL / PORTAL_PROVISION_SECRET not set — skipping');
    return;
  }

  const tierMap = {
    monthly_4:  { name: '4 Videos / Year', videos_per_year: 4 },
    monthly_8:  { name: '8 Videos / Year', videos_per_year: 8 },
    monthly_12: { name: '12 Videos / Year', videos_per_year: 12 },
  };
  const tier     = site.subscription_tier ?? '';
  const tierMeta = tierMap[tier] ?? { name: 'Video Reviews', videos_per_year: 0 };

  await _post({
    email:        site.email,
    product_type: 'video_subscription',
    external_ref: site.paypal_subscription_id ?? '',
    label:        tierMeta.name,
    domain:       site.domain      ?? '',
    country_code: site.country_code ?? '',
    status:       site.subscription_status ?? 'active',
    metadata: {
      tier:                   tier,
      paypal_subscription_id: site.paypal_subscription_id ?? '',
      next_billing_date:      site.next_billing_date       ?? '',
      billing_amount:         site.billing_amount          ?? '',
      currency:               site.billing_currency        ?? '',
      videos_per_year:        tierMeta.videos_per_year,
      videos_delivered:       site.videos_delivered        ?? 0,
    },
  });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _post(body) {
  let response;
  try {
    response = await fetch(PROVISION_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + PROVISION_SECRET,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[provision-portal] Network error: ${err.message}`);
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(`[provision-portal] HTTP ${response.status}: ${text}`);
    return;
  }

  const json = await response.json().catch(() => null);
  if (json?.success) {
    console.log(`[provision-portal] ${json.action} customer=${json.customer_id} product=${json.product_id} (${body.product_type})`);
  } else {
    console.warn('[provision-portal] Unexpected response:', JSON.stringify(json));
  }
}
