/**
 * Pure functions for Shotstack video generation — no side effects, no I/O.
 * Imported by both shotstack.js (CLI) and tests.
 */

// ─── Voiceover script builder ─────────────────────────────────────────────────

/**
 * Build a ~40s voiceover script from a prospect's review.
 *
 * Structure:
 *   "Here's what customers are saying about {name} in {city}."  ← hook
 *   {review quote, trimmed to ≤320 chars at sentence boundary}  ← body
 *   "Five stars from {reviewer}."                               ← attribution
 *   "{name} — trusted by locals across {city}. Book today."    ← CTA
 *
 * @param {{ business_name: string, city?: string, best_review_author?: string, best_review_text?: string }} prospect
 * @returns {string}
 */
export function buildVoiceoverScript(prospect) {
  const name = businessName(prospect.business_name);
  const city = prospect.city || 'Sydney';
  const reviewer = prospect.best_review_author || 'a customer';
  const review = prospect.best_review_text || '';

  let quote = review.replace(/\s+/g, ' ').trim();
  if (quote.length > 320) {
    const cut = quote.substring(0, 320);
    const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    quote = lastStop > 150 ? cut.substring(0, lastStop + 1) : cut + '...';
  }

  return [
    `Here's what customers are saying about ${name} in ${city}.`,
    quote,
    `Five stars from ${reviewer}.`,
    `${name} — trusted by locals across ${city}. Book your service today.`,
  ].join('  ');
}

// ─── Scene text builder ───────────────────────────────────────────────────────

/**
 * Build 5 scene text overlays from a prospect's review.
 *
 * Scenes:
 *   1. Hook    — "What customers say about {name}"
 *   2. Quote 1 — first sentence of review (≤100 chars)
 *   3. Quote 2 — second sentence (≤100 chars), falls back to quote 1
 *   4. Stars   — "⭐⭐⭐⭐⭐ — {reviewer}"
 *   5. CTA     — "{name}\n{city} | Book Now"
 *
 * @param {{ business_name: string, city?: string, best_review_author?: string, best_review_text?: string }} prospect
 * @returns {Array<{ text: string, duration: number }>}
 */
export function buildSceneTexts(prospect) {
  const name = businessName(prospect.business_name);
  const city = prospect.city || 'Sydney';
  const reviewer = prospect.best_review_author || 'a customer';
  const review = (prospect.best_review_text || '').replace(/\s+/g, ' ').trim();

  const q1 = extractSentence(review, 0);
  const q2 = extractSentence(review, q1.length) || q1;

  return [
    { text: `What customers say about\n${name}`, duration: 5 },
    { text: `"${q1}"`, duration: 12 },
    { text: `"${q2}"`, duration: 10 },
    { text: `⭐⭐⭐⭐⭐\n— ${reviewer}`, duration: 7 },
    { text: `${name}\n${city} | Book Now`, duration: 7 },
  ];
}

// ─── Render payload builder ───────────────────────────────────────────────────

/**
 * Build a Shotstack Edit API render payload.
 *
 * Track layout (top = rendered on top):
 *   Track 0: text overlays (one per scene, centre-positioned)
 *   Track 1: video clips  (one per scene, cover-fit, muted)
 *   Track 2: audio        (full-length voiceover)
 *
 * @param {string[]} clips          Array of 5 public MP4 URLs
 * @param {string}   audioUrl       Public MP3 URL (ElevenLabs output)
 * @param {Array<{ text: string, duration: number }>} scenes  From buildSceneTexts()
 * @param {string|null} [logoUrl]   Optional image URL for CTA scene overlay
 * @returns {object}                Shotstack /render POST body
 */
export function buildRenderPayload(clips, audioUrl, scenes, logoUrl = null) {
  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
  const starts = cumulativeStarts(scenes);

  const FALLBACK_CLIP = 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/footage/skater.hd.mp4';

  const videoTrack = {
    clips: clips.map((src, i) => ({
      asset: {
        type: 'video',
        src: src || FALLBACK_CLIP,
        volume: 0,
        trim: 0,
      },
      start: starts[i],
      length: scenes[i].duration,
      fit: 'cover',
      transition: { in: 'fade', out: 'fade' },
    })),
  };

  const textTrack = {
    clips: scenes.map((scene, i) => ({
      asset: {
        type: 'text',
        text: scene.text,
        width: 900,
        height: 400,
        font: {
          family: 'Montserrat ExtraBold',
          size: i === scenes.length - 1 ? 52 : 48,
          color: '#FFFFFF',
          lineHeight: 1.3,
        },
        alignment: { horizontal: 'center', vertical: 'center' },
        background: { color: '#000000', opacity: 0.5, borderRadius: 8, padding: 16 },
      },
      start: starts[i] + 0.5,
      length: scene.duration - 0.5,
      position: 'center',
    })),
  };

  const audioTrack = {
    clips: [{
      asset: { type: 'audio', src: audioUrl, volume: 1 },
      start: 0,
      length: totalDuration,
    }],
  };

  const tracks = [textTrack, videoTrack, audioTrack];

  // Optional logo overlay on final (CTA) scene
  if (logoUrl) {
    const ctaStart = starts[scenes.length - 1];
    const ctaDuration = scenes[scenes.length - 1].duration;
    const logoTrack = {
      clips: [{
        asset: { type: 'image', src: logoUrl },
        start: ctaStart + 0.5,
        length: ctaDuration - 0.5,
        position: 'bottomCenter',
        offset: { y: -0.12 },
        scale: 0.25,
      }],
    };
    tracks.unshift(logoTrack); // renders on top
  }

  return {
    timeline: {
      background: '#000000',
      tracks,
    },
    output: {
      format: 'mp4',
      size: { width: 1080, height: 1920 },
      fps: 25,
      quality: 'high',
    },
  };
}

// ─── Clip pool ────────────────────────────────────────────────────────────────

/**
 * Curated clip pools per niche — manually screened, no logos/branding.
 * Keys match prospect.niche values. 'default' is the fallback.
 *
 * Each entry is { url: string, source: string } where source identifies the
 * clip provider (e.g. 'kling', 'pexels', 'istock', 'sora', 'mixkit').
 * Tracking source allows bulk removal if a provider's licence changes.
 *
 * Scene slots: [hook, technician, treatment, resolution, cta]
 */
export const CLIP_POOLS = {
  'pest control': {
    hook:        [],  // Scene 1 — stressed homeowner or pest close-up
    technician:  [],  // Scene 2 — tech arriving at residential property
    treatment:   [],  // Scene 3 — spraying / inspection
    resolution:  [],  // Scene 4 — happy family / clean home
    cta:         [],  // Scene 5 — handshake / job done / neutral
  },
  default: {
    hook:        [],
    technician:  [],
    treatment:   [],
    resolution:  [],
    cta:         [],
  },
};

/**
 * Pick clips from the curated pool for a given niche.
 * Rotates through available clips using the prospect ID to vary per video.
 * Falls back to Pexels search queries when pool is empty (pre-curation).
 *
 * @param {string} niche
 * @param {number} seed   Used to rotate clip selection (e.g. prospect.id)
 * @returns {string[]|null}  Array of 5 URLs, or null if pool is empty
 */
export function pickClipsFromPool(niche, seed = 0) {
  const pool = CLIP_POOLS[niche] || CLIP_POOLS.default;
  const slots = ['hook', 'technician', 'treatment', 'resolution', 'cta'];

  // Return null if any slot is empty — caller falls back to Pexels search
  if (slots.some(s => !pool[s]?.length)) return null;

  return slots.map((slot, i) => {
    const arr = pool[slot];
    return arr[(seed + i) % arr.length].url;
  });
}

/**
 * Return all clips from CLIP_POOLS filtered by source provider.
 * Useful for auditing or bulk-removing clips from a specific vendor.
 *
 * @param {string} source  e.g. 'kling', 'pexels', 'istock'
 * @returns {{ niche: string, slot: string, url: string }[]}
 */
export function clipsBySource(source) {
  const results = [];
  for (const [niche, slots] of Object.entries(CLIP_POOLS)) {
    for (const [slot, clips] of Object.entries(slots)) {
      for (const clip of clips) {
        if (clip.source === source) results.push({ niche, slot, url: clip.url });
      }
    }
  }
  return results;
}

// ─── Pexels fallback queries ──────────────────────────────────────────────────

/**
 * Fallback Pexels search queries used when the curated pool is empty.
 * These produce variable results — replace with curated pool ASAP.
 */
export const PEXELS_FALLBACK_QUERIES = {
  'pest control': [
    'cockroach home interior',
    'pest control technician home',
    'exterminator spraying house interior',
    'happy family clean home',
    'professional handshake front door',
  ],
  default: [
    'worried homeowner stress',
    'professional technician home service',
    'home inspection professional',
    'happy satisfied homeowner',
    'professional service front door',
  ],
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Extract the first part of a business name (before any | separator). */
export function businessName(raw) {
  return (raw || '').split('|')[0].trim();
}

/**
 * Extract a sentence from text starting at `offset`.
 * Returns the first sentence of 20–100 chars, or up to 90 chars with ellipsis.
 */
export function extractSentence(text, offset = 0) {
  const slice = text.substring(offset).trim();
  const match = slice.match(/^[^.!?]{20,100}[.!?]/);
  return match ? match[0] : slice.substring(0, 90) + (slice.length > 90 ? '...' : '');
}

/** Build cumulative start-time array from scenes. */
export function cumulativeStarts(scenes) {
  return scenes.reduce((acc, s, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + scenes[i - 1].duration);
    return acc;
  }, []);
}
