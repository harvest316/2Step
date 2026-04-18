/**
 * Pure functions for Shotstack video generation — no side effects, no I/O.
 * Imported by both shotstack.js (CLI) and tests.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIP_TAGS_PATH = resolve(__dirname, '../../clips/clip-tags.json');

/**
 * Per-clip metadata loaded from clips/clip-tags.json.
 * Keys are filenames (e.g. "blocked-drain-hook-a.mp4"), values are objects
 * with { focus, gender } properties.
 * Backward compat: if a value is a plain string, treat it as { focus: value }.
 */
const CLIP_TAGS = (() => {
  if (!existsSync(CLIP_TAGS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CLIP_TAGS_PATH, 'utf8'));
    // Strip comment keys, normalise plain string values to { focus }
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, typeof v === 'string' ? { focus: v } : v])
    );
  } catch { return {}; }
})();

// Pronunciation is handled entirely by the ElevenLabs server-side pronunciation
// dictionary (src/video/pronunciation-dict.js). The suburb name is passed as-is
// in the voiceover text; ElevenLabs substitutes the alias before synthesis.
// Do NOT inline phonetic respellings here — they prevent the dict from matching.

// ─── Scene + voiceover builder ────────────────────────────────────────────────

/**
 * Build 7 aligned scene/voiceover pairs from a prospect's review.
 *
 * All clips are 5s. Voiceovers are written SHORT (≤12 words each, ~4s at 180wpm)
 * so audio fits inside the clip with no looping. Actual duration is measured from
 * the generated audio in creatomate.js and used as scene duration.
 *
 * Target total: ~30s (7 × ~4s audio + 0.4s tail each ≈ 31s).
 *
 * Scenes (7 slots: hook, technician, treatment, technician2, treatment2, resolution, cta):
 *   1. Hook    — short punchy intro naming the business
 *   2–5. Quotes — raw review sentences, read verbatim (no intro words)
 *   6. Stars   — reviewer name + star rating, no filler
 *   7. CTA     — business name + call/book prompt
 *
 * @param {{ business_name, city, best_review_author, best_review_text, phone }} prospect
 * @param {{ stateAbbreviations?: string[] }} opts
 * @returns {Array<{ text: string, voiceover: string, duration: number }>}
 */
export function buildScenes(prospect, { stateAbbreviations = [] } = {}) {
  const name      = businessName(prospect.business_name, stateAbbreviations);
  const cityRaw   = prospect.city || 'Sydney';  // display text (subtitle)
  const city      = cityRaw; // pronunciation handled by ElevenLabs dictionary (pronunciation-dict.js)
  const niche     = (prospect.niche || '').toLowerCase();
  const reviewer  = cleanReviewerName(prospect.best_review_author);
  const rawReview = (prospect.best_review_text || '').replace(/\s+/g, ' ').trim();
  const review    = cleanReviewText(rawReview) || rawReview;  // clean, fall back to raw if spam-detected
  const phoneRaw  = prospect.phone || null;
  const phone     = formatPhoneNational(phoneRaw);  // national display format
  const phoneTTS  = formatPhoneTTS(phone);           // spelled-out for voiceover
  const rating    = prospect.google_rating ? Math.round(prospect.google_rating) : 5;
  const starsText = `${rating} Star${rating === 1 ? '' : 's'}`;
  const starsVoiceover = ['', 'One star', 'Two stars', 'Three stars', 'Four stars', 'Five stars'][rating] || `${rating} stars`;

  // Build niche-appropriate hook text — always names the specific problem
  // Use problem_category if available (matches actual clip pool used at render time)
  let hookText, hookVoiceover;
  if (niche === 'plumber' || niche === 'plumbing') {
    // Detect specific plumbing problem from review text (like pest detection)
    const detected = detectPlumbingProblem(review);
    const poolKey = prospect.problem_category || detected || 'blocked-drain';
    const plumbingLabels = {
      'blocked-drain': 'a blocked drain',
      'burst-pipe':    'a burst pipe',
      'leaking-tap':   'a leaking tap',
      'hot-water':     'hot water issues',
      'toilet':        'a toilet problem',
      'gas-fitting':   'a gas fitting issue',
    };
    const problem = plumbingLabels[poolKey] || 'a plumbing problem';
    hookText      = `Got ${problem} in ${cityRaw}?`;
    hookVoiceover = `Got ${problem} in ${city}?`;
  } else if (niche.includes('cleaning') || niche.includes('cleaner')) {
    const detected = detectCleaningProblem(review);
    const poolKey = prospect.problem_category || detected || 'deep-clean';
    const cleaningLabels = {
      'greasy-rangehood': 'your rangehood cleaned',
      'dirty-bathroom':   'your bathroom deep-cleaned',
      'end-of-lease':     'an end-of-lease clean',
      'deep-clean':       'a deep clean',
      'regular-clean':    'a regular clean',
      'carpet-floor':     'your carpets cleaned',
    };
    const problem = cleaningLabels[poolKey] || 'a professional clean';
    hookText      = `Need ${problem} in ${cityRaw}?`;
    hookVoiceover = `Need ${problem} in ${city}?`;
  } else {
    // Pest control — placeholder hook; finalised after quote extraction
    // so we can verify the detected pest actually appears in selected quotes.
    hookText = hookVoiceover = null; // set below
  }

  // Extract 4 COMPLETE sentences — no truncation, prefer ≤15 words, never cut mid-sentence
  const quotes = extractQuotes(review, 4);

  // Finalise pest hook: only name the pest if we have clips AND quotes mention it.
  if (!hookText) {
    const pest     = detectPestFromReview(review);
    const hasClips = pest && CLIP_POOLS[pest];
    const pestWord = hasClips ? pestLabel(pest) : null;
    const quotesText = quotes.join(' ').toLowerCase();
    // Match singular or plural form (e.g. "termite" matches "termites" pest label)
    const pestStem = pestWord?.toLowerCase().replace(/e?s$/, '');
    const pestInQuotes = pestStem && quotesText.includes(pestStem);
    if (pestWord && pestInQuotes) {
      hookText      = `Dealing with ${pestWord} in ${cityRaw}?`;
      hookVoiceover = `Dealing with ${pestWord} in ${city}?`;
    } else {
      hookText      = `Got a pest problem in ${cityRaw}?`;
      hookVoiceover = `Got a pest problem in ${city}?`;
    }
  }

  // CTA slide: logo is shown → don't repeat name in subtitle (logo IS the name).
  // But DO say the name in voiceover so the viewer hears it while seeing the logo.
  // Without logo → show name in subtitle where logo would be.
  const hasLogo = !!prospect.logo_url;
  const ctaText = hasLogo
    ? (phone ? `Call ${phone}` : `Free Inspection`)
    : (phone ? `${name}\nCall ${phone}` : `${name}\nFree Inspection`);
  const ctaVoiceover = phone
    ? `${name}. Call ${phoneTTS} to schedule your free inspection.`
    : `Visit ${name} to schedule your free inspection.`;

  return [
    {
      text:      hookText,
      voiceover: hookVoiceover,
    },
    {
      text:      `"${quotes[0]}"`,
      voiceover: smoothGrammar(quotes[0]),
    },
    {
      text:      `"${quotes[1]}"`,
      voiceover: smoothGrammar(quotes[1]),
    },
    {
      text:      `"${quotes[2]}"`,
      voiceover: smoothGrammar(quotes[2]),
    },
    {
      text:      `"${quotes[3]}"`,
      voiceover: smoothGrammar(quotes[3]),
    },
    {
      text:      `${starsText}\n— ${reviewer}`,
      voiceover: `${starsVoiceover} — ${smoothReviewerName(prospect.best_review_author)}.`,
    },
    {
      text:      ctaText,
      voiceover: ctaVoiceover,
    },
  ].map(s => ({ ...s, duration: 5 })); // placeholder; creatomate.js overwrites with measured audio duration
}

/**
 * Estimate spoken duration in seconds for a string.
 * ElevenLabs Charlie speaks at ~180 wpm; +1s padding for lead-in/tail.
 * @param {string} text
 * @returns {number}
 */
export function sceneDuration(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words / 180 * 60) + 1;
}

/**
 * Build voiceover script from scenes — just join the voiceover segments.
 * @param {Array<{ voiceover: string }>} scenes
 * @returns {string}
 */
export function buildVoiceoverScript(scenes) {
  return scenes.map(s => s.voiceover).join('  ');
}

/**
 * Build scene texts array (legacy shape) from scenes for buildRenderPayload.
 * @param {Array<{ text: string, duration: number }>} scenes
 * @returns {Array<{ text: string, duration: number }>}
 */
export function buildSceneTexts(scenes) {
  return scenes.map(({ text, duration }) => ({ text, duration }));
}

// ─── Render payload builder ───────────────────────────────────────────────────

/**
 * Strip SSML/XML tags from a string, leaving only the spoken text content.
 * Used to normalise voiceover strings before character-position matching
 * against ElevenLabs alignment data (which covers only spoken characters).
 * @param {string} s
 * @returns {string}
 */
export function stripSsml(s) {
  return s.replace(/<[^>]+>/g, '');
}

/**
 * Derive exact scene durations from ElevenLabs character-level alignment data.
 *
 * ElevenLabs `/with-timestamps` returns an alignment object with seconds-based fields:
 *   { characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }
 *
 * Strategy: the voiceover script is built by joining scene voiceovers with "  " (double space).
 * We split the stripped script on that separator to get per-scene character counts, then
 * walk through the alignment array in order — assigning the first N1 non-whitespace
 * characters to scene 1, the next N2 to scene 2, etc.  This is robust to Opus writing
 * slightly different voiceover text than the text field (indexOf would fail in that case).
 *
 * Each scene's duration = end time of its last character − start time of its first + 0.5s tail.
 *
 * @param {Array<{ voiceover: string }>} scenes
 * @param {string} voiceoverScript   The exact string sent to ElevenLabs (may contain SSML)
 * @param {{ characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }} alignment
 * @returns {number[]}  Duration in seconds for each scene (minimum 2s)
 */
export function timingsToSceneDurations(scenes, voiceoverScript, alignment) {
  const startTimes = alignment.character_start_times_seconds
    ?? alignment.character_start_times_millis?.map(ms => ms / 1000);
  const endTimes   = alignment.character_end_times_seconds
    ?? alignment.character_durations_millis?.map((dur, i) =>
        (alignment.character_start_times_millis[i] + dur) / 1000
    );

  const alignChars = alignment.characters;

  // Count non-whitespace characters in each scene's spoken voiceover (SSML stripped).
  // These counts tell us how many alignment entries belong to each scene.
  const sceneCounts = scenes.map(s => {
    const spoken = stripSsml(s.voiceover);
    return spoken.replace(/\s/g, '').length;
  });

  // Walk the alignment array, assigning entries to scenes by character count.
  const sceneDurs = [];
  let ai = 0; // current position in alignment arrays

  for (let si = 0; si < scenes.length; si++) {
    let remaining = sceneCounts[si];
    let firstIdx = -1;
    let lastIdx  = -1;

    while (ai < alignChars.length && remaining > 0) {
      if (alignChars[ai].trim() !== '') {
        if (firstIdx === -1) firstIdx = ai;
        lastIdx = ai;
        remaining--;
      }
      ai++;
    }
    // Skip inter-scene whitespace in alignment (ElevenLabs may include spaces)
    while (ai < alignChars.length && alignChars[ai].trim() === '') ai++;

    if (firstIdx === -1) {
      sceneDurs.push(4); // no characters found — fallback
    } else {
      const durSecs = (endTimes[lastIdx] - startTimes[firstIdx]) + 0.5;
      sceneDurs.push(Math.max(2, Math.round(durSecs * 10) / 10));
    }
  }

  return sceneDurs;
}

/**
 * Return the text overlay position for a clip.
 *
 * focus-overrides.json now stores WHERE SUBTITLES APPEAR (not subject location).
 * Values: 'top' | 'bottom' | 'center' — used directly as the Shotstack position.
 * Default: 'bottom' (safe for most portrait clips where subject fills upper frame).
 */
function textPosition(focus) {
  if (focus === 'top' || focus === 'bottom' || focus === 'center') return focus;
  return 'bottom'; // fallback
}

/**
 * Logo goes opposite the text so they don't compete.
 * text 'top'    → logo at bottom
 * text 'bottom' → logo at top
 */
function logoPosition(tPos) {
  return tPos === 'top' ? 'bottom' : 'top';
}

/**
 * Build a Shotstack Edit API render payload.
 *
 * Track layout (top = rendered on top):
 *   Track 0: text overlays (one per scene, positioned opposite clip focus)
 *   Track 1: video clips  (one per scene, cover-fit, muted)
 *   Track 2: voiceover audio (full-length)
 *   Track 3: background music (low volume, full-length, optional)
 *
 * @param {Array<{url: string, focus?: string}|string>} clips  Array of 5 clip objects or plain URLs
 * @param {string}   audioUrl       Public MP3 URL (ElevenLabs output)
 * @param {Array<{ text: string, duration: number }>} scenes  From buildSceneTexts()
 * @param {string|null} [logoUrl]   Optional image URL for hook + CTA scene overlay
 * @param {string|null} [musicUrl]  Optional background music URL (royalty-free)
 * @returns {object}                Shotstack /render POST body
 */
export function buildRenderPayload(clips, audioUrl, scenes, logoUrl = null, musicUrl = null) {
  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
  const starts = cumulativeStarts(scenes);

  // Normalise clips: accept both plain strings and {url, focus} objects
  const clipData = clips.map(c =>
    typeof c === 'string' ? { url: c, focus: 'center' } : { focus: 'center', ...c }
  );

  const FALLBACK_CLIP = 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/footage/skater.hd.mp4';

  const videoTrack = {
    clips: clipData.map(({ url }, i) => ({
      asset: {
        type: 'video',
        src: url || FALLBACK_CLIP,
        volume: 0,
        trim: 0,
      },
      start: round2(starts[i]),
      length: round2(scenes[i].duration),
      fit: 'cover',
      transition: { in: 'fade', out: 'fade' },
    })),
  };

  const textTrack = {
    clips: scenes.map((scene, i) => {
      const tPos = textPosition(clipData[i]?.focus);
      return {
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
        start: round2(starts[i] + 0.5),
        length: round2(scene.duration - 0.5),
        position: tPos,
      };
    }),
  };

  const voiceoverTrack = {
    clips: [{
      asset: { type: 'audio', src: audioUrl, volume: 1 },
      start: 0,
      length: round2(totalDuration),
    }],
  };

  const tracks = [textTrack, videoTrack, voiceoverTrack];

  // Optional background music — low volume so voiceover stays clear
  if (musicUrl) {
    const musicTrack = {
      clips: [{
        asset: { type: 'audio', src: musicUrl, volume: 0.12 },
        start: 0,
        length: round2(totalDuration),
      }],
    };
    tracks.push(musicTrack);
  }

  // Optional logo overlay on first (hook) and last (CTA) scenes.
  // Logo is placed at the same position as the text overlay (opposite the focus point)
  // so it doesn't compete with the visual subject.
  if (logoUrl) {
    const logoClip = (start, length, focus) => {
      // Logo goes opposite the text so they don't overlap each other.
      const tPos = textPosition(focus);
      const pos  = logoPosition(tPos);
      // y-offset nudges logo away from the very edge so it stays fully visible.
      // Positive = down (for top logos), negative = up (for bottom logos).
      // -0.05 keeps bottom logos within the safe zone — -0.08 was clipping them.
      const yOffset = pos === 'top' ? 0.05 : -0.05;
      return {
        asset: { type: 'image', src: logoUrl },
        start: start + 0.5,
        length: length - 0.5,
        position: pos,
        offset: { y: yOffset },
        scale: 0.12,
      };
    };
    const logoTrack = {
      clips: [
        logoClip(starts[0], scenes[0].duration, clipData[0]?.focus),
        logoClip(starts[scenes.length - 1], scenes[scenes.length - 1].duration, clipData[scenes.length - 1]?.focus),
      ],
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
 * Each entry is { url: string, source: string, focus?: string } where:
 *   source  — clip provider ('kling', 'pexels', etc.) for licence auditing
 *   focus   — where the visual subject is: 'top'|'center'|'bottom' (default 'center')
 *             Used to position text overlays and logo on the opposite side.
 *             Future use: also informs crop anchor for landscape/1:1 exports.
 *
 * Scene slots: [hook, technician, treatment, resolution, cta]
 *
 * Shared slots (technician, resolution, cta) are pest-agnostic — the tech
 * wears a plain uniform and the resolution/cta shots show no specific pest.
 * Pest-specific niches only need hook + treatment clips.
 */
const R2 = 'https://pub-9e277996d5a74eee9508a861cccead66.r2.dev';

export const CLIP_POOLS = {
  // Shared slots reused across all pest-control niches
  shared: {
    technician: [
      { url: `${R2}/shared-technician-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-e.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-f.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-g.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-technician-h.mp4`, source: 'kling', focus: 'center' },
    ],
    resolution: [
      { url: `${R2}/shared-resolution-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-e.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-f.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-g.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-resolution-h.mp4`, source: 'kling', focus: 'center' },
    ],
    cta: [
      { url: `${R2}/shared-cta-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-e.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-f.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-g.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/shared-cta-h.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  cockroaches: {
    hook: [
      { url: `${R2}/cockroaches-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/cockroaches-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/cockroaches-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  termites: {
    hook: [
      { url: `${R2}/termites-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/termites-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/termites-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  spiders: {
    hook: [
      { url: `${R2}/spiders-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/spiders-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/spiders-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  rodents: {
    hook: [
      { url: `${R2}/rodents-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/rodents-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/rodents-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  possums: {
    hook: [
      { url: `${R2}/possum-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/possum-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/possum-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/possum-hook-d.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/possum-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/possum-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/possum-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/possum-treatment-d.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'general-pest': {
    hook: [
      { url: `${R2}/general-pest-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/general-pest-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/general-pest-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/general-pest-hook-d.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/general-pest-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/general-pest-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/general-pest-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/general-pest-treatment-d.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  // ── Plumbing shared (technician, resolution, cta) ─────────────────────────
  'plumbing-shared': {
    technician: [
      { url: `${R2}/plumbing-technician-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-technician-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-technician-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-technician-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-technician-e.mp4`, source: 'kling', focus: 'center' },
    ],
    resolution: [
      { url: `${R2}/plumbing-resolution-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-resolution-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-resolution-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-resolution-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-resolution-e.mp4`, source: 'kling', focus: 'center' },
    ],
    cta: [
      { url: `${R2}/plumbing-cta-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-cta-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-cta-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-cta-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/plumbing-cta-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  // ── Plumbing problems ──────────────────────────────────────────────────────
  'blocked-drain': {
    hook: [
      { url: `${R2}/blocked-drain-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/blocked-drain-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/blocked-drain-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'burst-pipe': {
    hook: [
      { url: `${R2}/burst-pipe-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/burst-pipe-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/burst-pipe-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'leaking-tap': {
    hook: [
      { url: `${R2}/leaking-tap-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/leaking-tap-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/leaking-tap-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'hot-water': {
    hook: [
      { url: `${R2}/hot-water-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/hot-water-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/hot-water-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'toilet': {
    hook: [
      { url: `${R2}/toilet-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/toilet-hook-c.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/toilet-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/toilet-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/toilet-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/toilet-treatment-d.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  // ── House cleaning shared (technician, resolution, cta) ───────────────────
  'house-cleaning-shared': {
    technician: [
      { url: `${R2}/house-cleaning-technician-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-technician-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-technician-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-technician-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-technician-e.mp4`, source: 'kling', focus: 'center' },
    ],
    resolution: [
      { url: `${R2}/house-cleaning-resolution-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-resolution-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-resolution-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-resolution-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-resolution-e.mp4`, source: 'kling', focus: 'center' },
    ],
    cta: [
      { url: `${R2}/house-cleaning-cta-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-cta-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-cta-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-cta-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/house-cleaning-cta-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  // ── House cleaning problems ───────────────────────────────────────────────
  'greasy-rangehood': {
    hook: [
      { url: `${R2}/greasy-rangehood-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/greasy-rangehood-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/greasy-rangehood-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'dirty-bathroom': {
    hook: [
      { url: `${R2}/dirty-bathroom-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/dirty-bathroom-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-treatment-c.mp4`, source: 'kling', focus: 'top' },
      { url: `${R2}/dirty-bathroom-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/dirty-bathroom-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'end-of-lease': {
    hook: [
      { url: `${R2}/end-of-lease-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/end-of-lease-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/end-of-lease-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'deep-clean': {
    hook: [
      { url: `${R2}/deep-clean-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-hook-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-hook-e.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/deep-clean-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-treatment-d.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/deep-clean-treatment-e.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  'regular-clean': {
    hook: [
      { url: `${R2}/regular-clean-hook-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/regular-clean-hook-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/regular-clean-hook-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/regular-clean-hook-d.mp4`, source: 'kling', focus: 'center' },
    ],
    treatment: [
      { url: `${R2}/regular-clean-treatment-a.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/regular-clean-treatment-b.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/regular-clean-treatment-c.mp4`, source: 'kling', focus: 'center' },
      { url: `${R2}/regular-clean-treatment-d.mp4`, source: 'kling', focus: 'center' },
    ],
  },

  // Generic fallback (used by unknown niches)
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
 * @returns {Array<{url: string, focus: string}>|null}  Array of 5 clip objects, or null if pool is empty
 */
// Maps broad niche names → default problem slug used when no problem is specified.
const NICHE_ALIASES = {
  'pest control':          'general-pest',  // fallback when no specific pest detected
  'house cleaning':        'greasy-rangehood',
  'cleaning':              'greasy-rangehood',
  'house cleaning service':'greasy-rangehood',
  'plumber':               'blocked-drain',
  'plumbing':              'blocked-drain',
};

/**
 * Detect specific pest type from review text.
 * Returns a CLIP_POOLS key if found, otherwise null (caller uses niche alias default).
 */
export function detectPestFromReview(reviewText) {
  const t = reviewText.toLowerCase();

  // Count mentions of each pest — most-mentioned wins.
  // "termite inspection" counts less than active infestation language.
  const score = (patterns) => {
    let n = 0;
    for (const p of patterns) { const m = t.match(new RegExp(p, 'g')); if (m) n += m.length; }
    return n;
  };

  const counts = {
    termites:    score([/termite(?!.{0,20}(inspection|barrier|warranty))/]),  // discount routine/preventive mentions
    cockroaches: score([/cockroach|roach/]),
    spiders:     score([/spider/]),
    rodents:     score([/\brat\b|\brats\b|\bmouse\b|\bmice\b|rodent/]),
    possums:     score([/possum/]),
    wasps:       score([/wasp/]),
    ants:        score([/\bant\b|\bants\b|carpenter ant/]),
    bedbugs:     score([/bed ?bug/]),
  };

  // Fall back to including routine/preventive termite mentions if no active pest found
  if (Object.values(counts).every(n => n === 0)) {
    counts.termites = score([/termite/]);
  }

  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/**
 * Detect specific cleaning problem from review text.
 * Returns a clip pool key or null.
 */
export function detectCleaningProblem(reviewText) {
  const t = reviewText.toLowerCase();
  const score = (patterns) => {
    let n = 0;
    for (const p of patterns) { const m = t.match(new RegExp(p, 'g')); if (m) n += m.length; }
    return n;
  };

  const counts = {
    'greasy-rangehood': score([/rangehood/, /oven/, /stovetop/, /cooktop/, /greasy/, /grease/]),
    'dirty-bathroom':   score([/bathroom/, /toilet/, /shower/, /bathtub/, /grout/, /mould/, /mold/]),
    'end-of-lease':     score([/lease/, /bond/, /vacate/, /moving out/, /landlord/]),
    'deep-clean':       score([/deep clean/, /spring clean/, /thorough/, /spotless/, /immaculate/]),
    'regular-clean':    score([/weekly/, /fortnightly/, /regular/, /scheduled/, /recurring/]),
    'carpet-floor':     score([/carpet/, /floor/, /steam clean/, /timber/, /grout/]),
  };

  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/**
 * Detect specific plumbing problem from review text.
 * Returns a CLIP_POOLS key if found, otherwise null (falls back to 'blocked-drain').
 */
export function detectPlumbingProblem(reviewText) {
  const t = reviewText.toLowerCase();
  const score = (patterns) => {
    let n = 0;
    for (const p of patterns) { const m = t.match(new RegExp(p, 'g')); if (m) n += m.length; }
    return n;
  };

  const counts = {
    'blocked-drain': score([/blocked drain/, /blocked pipe/, /clogged drain/, /\bdrain\b/, /sewer/, /unblocking/]),
    'burst-pipe':    score([/burst pipe/, /burst/, /flood/, /emergency plumb/]),
    'leaking-tap':   score([/leak/, /drip/, /\btap\b/, /\btaps\b/, /faucet/]),
    'hot-water':     score([/hot water/, /heater/, /boiler/, /rheem/, /rinnai/]),
    'toilet':        score([/toilet/, /cistern/, /flush/, /blocked toilet/]),
    'gas-fitting':   score([/\bgas\b/, /gas fit/, /cooktop/, /gas leak/]),
  };

  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/**
 * Human-readable pest label for voiceover ("termites", "cockroaches", etc.)
 */
export function pestLabel(problem) {
  return { termites: 'termites', cockroaches: 'cockroaches', spiders: 'spiders', rodents: 'rodents', possums: 'possums' }[problem] || 'pests';
}

// Maps problem slug → shared pool key for technician/resolution/cta
const PROBLEM_SHARED_POOL = {
  'cockroaches':     'shared',
  'rodents':         'shared',
  'spiders':         'shared',
  'termites':        'shared',
  'possums':         'shared',
  'general-pest':    'shared',
  'blocked-drain':   'plumbing-shared',
  'burst-pipe':      'plumbing-shared',
  'leaking-tap':     'plumbing-shared',
  'hot-water':       'plumbing-shared',
  'toilet':          'plumbing-shared',
  'greasy-rangehood':'house-cleaning-shared',
  'dirty-bathroom':  'house-cleaning-shared',
  'end-of-lease':    'house-cleaning-shared',
  'deep-clean':      'house-cleaning-shared',
  'regular-clean':   'house-cleaning-shared',
};

// --- Gender-aware clip selection ---

const MALE_NAMES = new Set([
  // Anglo/Western
  'james','john','robert','michael','william','david','richard','joseph','thomas','charles',
  'christopher','daniel','matthew','anthony','mark','donald','steven','paul','andrew','joshua',
  'kenneth','kevin','brian','george','timothy','ronald','edward','jason','jeffrey','ryan',
  'jacob','gary','nicholas','eric','jonathan','stephen','larry','justin','scott','brandon',
  'benjamin','samuel','raymond','gregory','frank','patrick','jack','dennis','peter','henry',
  'carl','arthur','roger','keith','jeremy','terry','sean','austin','noah','ethan','liam',
  'mason','logan','lucas','oliver','aiden','connor','dylan','nathan','caleb','owen','luke',
  'hunter','tyler','aaron','adam','ian','colin','bruce','wayne','craig','dale','darren',
  'dean','glen','glenn','grant','neil','shane','stuart','trevor','barry','clive','nigel',
  'simon','graham','ross','angus','hamish','lachlan','callum','declan','cody','beau','cooper',
  'jim','dan','ben','tom','rob','mike','chris','matt','nick','dave','steve','joe','tony',
  'phil','bob','ted','bill','ed','ray','don','lee','reece','rhys','bryce','blake','trent',
  'brett','chad','derek','gavin','lloyd','malcolm','murray','noel','rex','rodney','russell',
  'warwick','mitch','cam','jared','toby','zach','riley','kai','finn',
  // South Asian
  'raj','ravi','amit','anil','arjun','vikram','suresh','deepak','sanjay','rahul',
  'rohit','ashish','nikhil','pranav','karthik','vishal','sachin','harsh','gaurav','vivek',
  // East Asian
  'wei','jun','ming','chen','hong','jian','lei','feng','tao','hai',
  'kenji','takeshi','hiroshi','yuki','ryu','jin','soo','hyun','min','sung',
  // Middle Eastern
  'mohammed','ahmed','ali','omar','hassan','hussein','khalid','tariq','mustafa','youssef',
  'ibrahim','karim','nasser','samir','faisal','jamal','bilal',
  // European
  'marco','luca','matteo','diego','carlos','miguel','rafael','antonio','giuseppe','pierre',
  'andre','dmitri','ivan','sergei','aleksander','jan','lars','erik','hans','stefan',
  // African
  'kwame','kofi','emeka','chidi','oluwa','jabari','tendai','thabo','sipho','bongani',
]);

const FEMALE_NAMES = new Set([
  // Anglo/Western
  'mary','patricia','jennifer','linda','barbara','elizabeth','susan','jessica','sarah','karen',
  'lisa','nancy','betty','margaret','sandra','ashley','dorothy','kimberly','emily','donna',
  'michelle','carol','amanda','melissa','deborah','stephanie','rebecca','sharon','laura','cynthia',
  'kathleen','amy','angela','shirley','anna','brenda','pamela','emma','nicole','helen',
  'samantha','katherine','christine','debra','rachel','carolyn','janet','catherine','maria','heather',
  'diane','ruth','julie','olivia','joyce','virginia','victoria','kelly','lauren','christina',
  'joan','evelyn','judith','megan','andrea','cheryl','hannah','jacqueline','martha','gloria',
  'teresa','ann','sara','madison','frances','kathryn','janice','jean','abigail','alice',
  'judy','sophia','grace','denise','amber','doris','marilyn','danielle','beverly','isabella',
  'theresa','diana','natalie','brittany','charlotte','marie','kayla','alexis','lori','chloe',
  'brooke','jade','holly','claire','fiona','gemma','lucy','sophie','zoe','ella',
  'mia','isla','freya','poppy','daisy','phoebe','willow','sienna','matilda','harper',
  'kate','jane','sue','kim','bec','mel','tash','nat','jen','jess','em','lyn','deb',
  'beth','meg','jo','gail','tina','leah','jill','faye','gwen','liz','val','wendy',
  'rowena','colleen','bronwyn','kylie','tanya','sharyn','kerrie','narelle','janelle',
  // South Asian
  'priya','anita','sunita','deepa','kavita','neha','pooja','shreya','divya','meera',
  'lakshmi','rani','nisha','swati','geeta','rekha','anjali','ritu','sita','padma',
  // East Asian
  'mei','ling','xia','yan','hui','yun','fang','jing','na','li',
  'yoko','akiko','sakura','hana','miki','seo','eun','hye','ji','yuna',
  // Middle Eastern
  'fatima','aisha','leila','noor','yasmin','hana','zahra','maryam','sara','dina',
  'rania','amira','layla','samira','farida','nadya',
  // European
  'sofia','elena','chiara','giulia','lucia','carmen','rosa','isabelle','claire','marie',
  'natasha','olga','katya','svetlana','anna','eva','ingrid','astrid','elsa','petra',
  // African
  'amara','nia','zara','imani','asha','fatou','adama','nana','abena','akua',
]);

/**
 * Detect the gender of the staff member mentioned in a Google review.
 * Looks at pronouns first (strongest signal), then staff names.
 * Returns 'male', 'female', or null if indeterminate.
 *
 * @param {string} reviewText  The review body text
 * @param {string} reviewerName  The reviewer's name (excluded from staff name detection)
 * @returns {'male'|'female'|null}
 */
export function detectStaffGender(reviewText, reviewerName = '') {
  if (!reviewText) return null;
  const text = reviewText.toLowerCase();

  // --- Pronoun detection (primary signal) ---
  // \b word boundaries already prevent "this"→"his" and "here"→"her" false positives
  const maleCount = (text.match(/\bhe\b/g) || []).length
    + (text.match(/\bhim\b/g) || []).length
    + (text.match(/\bhis\b/g) || []).length;
  const femaleCount = (text.match(/\bshe\b/g) || []).length
    + (text.match(/\bhers?\b/g) || []).length;

  if (maleCount > 0 || femaleCount > 0) {
    if (maleCount > femaleCount) return 'male';
    if (femaleCount > maleCount) return 'female';
    // Tie — fall through to name detection
  }

  // --- Name detection (secondary signal) ---
  // Look for staff-member name patterns: "X from [business]", "X was very/so/incredibly",
  // "X came/arrived", "X did an amazing"
  const reviewerFirst = reviewerName.trim().split(/\s+/)[0]?.toLowerCase() || '';
  const staffPatterns = [
    /\b([a-z]{2,})\s+(?:from|at)\s+/gi,
    /\b([a-z]{2,})\s+(?:was|is|did|came|arrived|helped|fixed|cleaned|handled|showed|explained|went)\b/gi,
    /\b([a-z]{2,})\s+(?:and his|and her)\b/gi,
  ];

  for (const pattern of staffPatterns) {
    let match;
    while ((match = pattern.exec(reviewText)) !== null) {
      const name = match[1].toLowerCase();
      if (name === reviewerFirst) continue;
      // Skip common non-name words that match the patterns
      if (['the', 'they', 'this', 'that', 'what', 'when', 'will', 'with', 'would',
           'very', 'really', 'just', 'also', 'even', 'then', 'than', 'them', 'been',
           'have', 'has', 'had', 'but', 'not', 'our', 'who', 'how', 'all', 'any',
           'can', 'could', 'should', 'which', 'their', 'there', 'these', 'those',
           'some', 'such', 'only', 'over', 'after', 'before', 'about', 'into',
           'through', 'during', 'each', 'both', 'few', 'more', 'most', 'other',
           'service', 'team', 'staff', 'company', 'business', 'work', 'job',
           'price', 'quote', 'everything', 'everyone', 'someone', 'something',
           'nothing', 'anything', 'always', 'never', 'great', 'good', 'best',
           'well', 'much', 'still', 'back', 'here', 'where', 'home', 'time',
           'place', 'house', 'water', 'drain', 'pipe', 'roof', 'pest',
      ].includes(name)) continue;
      if (MALE_NAMES.has(name)) return 'male';
      if (FEMALE_NAMES.has(name)) return 'female';
    }
  }

  return null;
}

// Slots where a person is visible and gender matching matters
const PEOPLE_SLOTS = new Set(['technician', 'resolution', 'cta']);

/**
 * Pick 5 clips (hook, technician, treatment, resolution, cta) for a given problem.
 *
 * @param {string} niche    Prospect niche (e.g. 'plumber', 'pest control', 'blocked-drain')
 * @param {number} seed     Rotates clip selection per prospect
 * @param {string} reviewerName  Reviewer's name (excluded from gender detection)
 * @returns {Array<{url,focus,gender}>|null}  7 clips, or null if any slot is empty
 */
export function pickClipsFromPool(niche, seed = 0, reviewText = '', reviewerName = '') {
  // For pest control, try to detect specific pest from review; fall back to general-pest
  const isPestControl = niche === 'pest control' || NICHE_ALIASES[niche] === 'general-pest';
  const detected = isPestControl ? detectPestFromReview(reviewText) : null;
  // Fall back to general-pest if detected pest has no clip pool (e.g. ants, wasps, bedbugs)
  const detectedWithFallback = detected && CLIP_POOLS[detected] ? detected : (detected ? 'general-pest' : null);
  const aliased = NICHE_ALIASES[niche];
  const problem = detectedWithFallback ?? aliased ?? niche;
  if (!problem) return null; // caller should surface this as an error
  const problemPool = CLIP_POOLS[problem];
  const sharedKey   = PROBLEM_SHARED_POOL[problem];
  const sharedPool  = sharedKey ? CLIP_POOLS[sharedKey] : null;
  const defaultPool = CLIP_POOLS.default;

  function resolveSlot(slot) {
    if (slot === 'hook' || slot === 'treatment') {
      if (problemPool?.[slot]?.length) return problemPool[slot];
      return defaultPool[slot] ?? [];
    }
    // technician / resolution / cta — use vertical shared pool
    if (sharedPool?.[slot]?.length) return sharedPool[slot];
    // pest-control fallback to global shared
    if (CLIP_POOLS.shared?.[slot]?.length) return CLIP_POOLS.shared[slot];
    return defaultPool[slot] ?? [];
  }

  // 7 slots: hook, technician×2, treatment×2, resolution, cta
  // treatment2/technician2 and cta use same pools with shifted seeds so clips differ
  // cta is last — user feedback: CTA scene is long (~7s) so a single 5s clip loops
  // visibly. Two different CTA clips back-to-back avoids the jump.
  const slots = ['hook', 'technician', 'treatment', 'technician2', 'treatment2', 'resolution', 'cta'];
  const baseSlot = s => s.replace(/\d+$/, ''); // 'technician2' → 'technician'
  if (['hook', 'technician', 'treatment', 'resolution', 'cta'].some(s => !resolveSlot(s).length)) return null;

  const detectedGender = detectStaffGender(reviewText, reviewerName);

  return slots.map((slot, i) => {
    const arr   = resolveSlot(baseSlot(slot));
    // Shift seed by ~half the pool size for *2 slots to get a different clip
    // Use a prime (7) so it doesn't alias with common pool sizes (5, 8)
    const offset = slot.endsWith('2') ? 7 : 0;

    // Gender-aware filtering for people slots (technician, resolution, cta)
    let pool = arr;
    if (detectedGender && PEOPLE_SLOTS.has(baseSlot(slot))) {
      const genderMatched = arr.filter(e => {
        const fn = e.url.split('/').pop();
        const tags = CLIP_TAGS[fn];
        return tags?.gender === detectedGender;
      });
      if (genderMatched.length) pool = genderMatched;
      // No matches → fall back to full unfiltered pool
    }

    const entry = pool[(seed + i + offset) % pool.length];
    const filename = entry.url.split('/').pop();
    const tags = CLIP_TAGS[filename] ?? {};
    const focus = tags.focus ?? entry.focus ?? 'center';
    return { url: entry.url, focus, gender: tags.gender ?? null };
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

export function toTitleCase(str) {
  return (str || '')
    .toLowerCase()
    .replace(/(?:^|\s)\w/g, c => c.toUpperCase());  // uppercase after whitespace only (not after ')
}

/**
 * Extract and clean a business name for use in voiceovers:
 * - Takes the first part before any | separator
 * - Strips legal suffixes (PTY LTD, LLC, GmbH, Inc, Ltd, Co, Corp, etc.)
 * - Strips state/territory abbreviations appended to the name (country-specific list)
 * - Converts ALL CAPS names to title case
 *
 * @param {string} raw              — raw business_name from DB
 * @param {string[]} stateAbbreviations — country-specific list from countries.state_abbreviations
 */
export function businessName(raw, stateAbbreviations = []) {
  let name = (raw || '').split('|')[0].trim();

  // Strip trailing state abbreviations — handles "- NSW", "(NSW)"
  if (stateAbbreviations.length > 0) {
    const stateList = stateAbbreviations.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    name = name
      .replace(new RegExp(`\\s*\\((?:${stateList})\\)\\s*$`, 'i'), '')  // "(NSW)"
      .replace(new RegExp(`\\s*[-–]\\s*(?:${stateList})\\s*$`, 'i'), '') // "- NSW"
      .trim();
  }

  // Strip legal entity suffixes (order matters: longer phrases first)
  name = name.replace(/[,\s]+(?:PTY\.?\s*LTD\.?|PROPRIETARY\s+LIMITED|PROPRIETARY\s+LTD\.?|P\/L|LLC\.?|LLP\.?|PLLC\.?|GmbH\.?|PLC\.?|N\.?V\.?|B\.?V\.?|S\.?A\.?|SARL\.?|S\.?R\.?L\.?|AG\.?|INC\.?|INCORPORATED|LIMITED|LTD\.?|CORP\.?|CORPORATION|CO\.?|COMPANY)$/i, '').trim();

  // If the name is ALL CAPS (or near all-caps), convert to title case
  const letters = name.replace(/[^a-zA-Z]/g, '');
  const upperRatio = letters.length > 0 ? (letters.replace(/[^A-Z]/g, '').length / letters.length) : 0;
  if (upperRatio > 0.7) {
    name = toTitleCase(name);
  }

  return name;
}

/**
 * Clean a Google reviewer name for display.
 * Handles: "Trillian'S Mouse" → "Trillian Mouse", "JOHN DOE" → "John Doe",
 * "jane d." → "Jane D", trailing periods, double spaces, possessive artifacts.
 */
export function cleanReviewerName(raw) {
  if (!raw) return 'a local';
  let name = raw.trim();
  // Strip parenthetical suffixes — Google platform artefact, not part of reviewer's name
  // "David Kirk (100adventures4u2c)" → "David Kirk"
  name = name.replace(/\s*\([^)]*\)\s*$/, '');
  // Remove possessive 's/'S that Google sometimes injects — platform bug, not reviewer's text.
  // "Trillian's Mouse" → "Trillian Mouse", "Trillian'S Mouse" → "Trillian Mouse".
  // Preserves O'Brien (apostrophe mid-word followed by lowercase letter).
  name = name.replace(/'[Ss]\b/g, '');
  // Remove stray apostrophes left over (but keep mid-word ones like O'Brien)
  name = name.replace(/'\s/g, ' ');
  // Don't alter casing — show the reviewer's name as they set it on Google.
  // Remove trailing periods ("Jane D." → "Jane D")
  name = name.replace(/\.\s*$/, '');
  // Collapse whitespace
  name = name.replace(/\s{2,}/g, ' ').trim();
  return name || 'a local';
}

// ─── Phone formatting ─────────────────────────────────────────────────────────

/**
 * Format phone to national display format.
 * +61412931208 → 0412 931 208, +611300319275 → 1300 319 275
 */
export function formatPhoneNational(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\s+/g, '');
  const m = digits.match(/^\+61(\d+)$/);
  const remainder = m ? m[1] : null;
  const local = remainder
    ? (remainder.length === 9 ? '0' + remainder : remainder)
    : digits;
  if (local.length === 10 && local.startsWith('04')) {
    return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
  }
  if (local.length === 10 && (local.startsWith('13') || local.startsWith('18'))) {
    return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
  }
  if (local.length === 10) {
    return local.slice(0, 2) + ' ' + local.slice(2, 6) + ' ' + local.slice(6);
  }
  return local;
}

/**
 * Smooth grammar for voiceover ONLY — never applied to subtitle text.
 * Fixes form (not meaning) so TTS sounds natural. The on-screen text
 * stays verbatim per ACL s.29 compliance.
 *
 * Rules are strictly meaning-neutral: "leak pipes" → "leaking pipes",
 * "a immaculate" → "an immaculate", etc.
 */
export function smoothGrammar(text) {
  if (!text) return text;
  let t = text;

  // ── Common typos (unambiguous) ──
  const TYPOS = {
    'agian': 'again', 'definately': 'definitely', 'reccomend': 'recommend',
    'recomend': 'recommend', 'proffessional': 'professional', 'accomodation': 'accommodation',
    'occured': 'occurred', 'seperate': 'separate', 'occassion': 'occasion',
    'maintainance': 'maintenance', 'definetly': 'definitely', 'definatly': 'definitely',
    'rediculous': 'ridiculous', 'recieved': 'received', 'bussiness': 'business',
    'excelent': 'excellent', 'acheive': 'achieve', 'occurance': 'occurrence',
    'independant': 'independent', 'consistant': 'consistent', 'immediantly': 'immediately',
    'knowledgable': 'knowledgeable', 'throughly': 'thoroughly', 'thier': 'their',
  };
  for (const [wrong, right] of Object.entries(TYPOS)) {
    t = t.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), right);
  }

  // ── ESL adjective → participle ──
  t = t.replace(/\bleak (pipe|tap|roof|wall|toilet|faucet|shower|hose)/gi, 'leaking $1');
  t = t.replace(/\bblock (drain|pipe|toilet|sink|sewer)/gi, 'blocked $1');
  t = t.replace(/\bbroke (pipe|tap|toilet|heater|system)/gi, 'broken $1');
  t = t.replace(/\bclog (drain|pipe|sink|toilet|sewer)/gi, 'clogged $1');
  t = t.replace(/\bdamage (roof|wall|pipe|floor|ceiling|property)/gi, 'damaged $1');
  t = t.replace(/\bstain (carpet|tile|floor|wall|ceiling|bench)/gi, 'stained $1');

  // ── Article agreement ──
  t = t.replace(/\ba (immaculate|excellent|outstanding|amazing|incredible|impressive|absolute|awful|easy|efficient|effective|expert|honest|hour|unusual|urgent|ultimate|update|end of)/gi, 'an $1');

  // ── Common autocorrect / typo swaps ──
  t = t.replace(/\b(and|the|to|of|in|is|a|an) \1\b/gi, '$1');   // doubled words
  t = t.replace(/\bdid and end\b/gi, 'did an end');
  t = t.replace(/\bThe confirmed\b/g, 'They confirmed');
  t = t.replace(/\bThe returned\b/g, 'They returned');
  t = t.replace(/\bThe were\b/g, 'They were');
  t = t.replace(/\bThe did\b/g, 'They did');
  t = t.replace(/\bThe came\b/g, 'They came');
  t = t.replace(/\bThe went\b/g, 'They went');

  // ── Informal abbreviations → spoken form ──
  t = t.replace(/\blol\b/gi, '');
  t = t.replace(/\bomg\b/gi, '');

  // ── Exclamation → period for TTS (avoids rising intonation on testimonial quotes) ──
  // Review quotes are statements of fact, not exclamations. TTS reads "!" with unnatural
  // rising pitch — converting to "." produces neutral, credible delivery.
  t = t.replace(/!+/g, '.');

  return t;
}

/**
 * Clean reviewer name for voiceover — normalise casing for spoken form.
 * Subtitle uses cleanReviewerName() (minimal — platform artefacts only).
 * Voiceover uses this to fix "jose" → "Jose", "DAVID KIRK" → "David Kirk".
 */
export function smoothReviewerName(raw) {
  if (!raw) return 'a local';
  let name = raw.trim();
  // Strip Google platform artefacts (same as cleanReviewerName)
  name = name.replace(/\s*\([^)]*\)\s*$/, '');
  name = name.replace(/'[Ss]\b/g, '');
  name = name.replace(/'\s/g, ' ');
  // Normalise casing for voiceover — fix all-lower ("jose") and ALL CAPS ("DAVID KIRK")
  // Leave mixed-case alone (preserves "McDonald", "O'Brien")
  // Leave initials alone ("R VM", "N B")
  const words = name.split(/\s+/);
  const isInitials = words.every(w => w.length <= 2);
  const isAllUpper = name === name.toUpperCase() && name.length > 2;
  const isAllLower = name === name.toLowerCase();
  if ((isAllUpper || isAllLower) && !isInitials) {
    name = name.toLowerCase().replace(/(?:^|\s)\w/g, c => c.toUpperCase());
  }
  name = name.replace(/\.\s*$/, '');
  name = name.replace(/\s{2,}/g, ' ').trim();
  return name || 'a local';
}

/**
 * Format phone for TTS — spells out digits so ElevenLabs doesn't mispronounce "0" as "zoe".
 */
export function formatPhoneTTS(phone) {
  if (!phone) return phone;
  const digitWords = { '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine' };
  return phone.split(' ').map(group =>
    group.split('').map(d => digitWords[d] || d).join(' ')
  ).join(', ');
}

// ─── Review cleaning ──────────────────────────────────────────────────────────

/**
 * Clean review text before quote extraction.
 * Strips emoji, fixes common typos, removes spam patterns.
 * Returns null if review appears to be spam/AI-generated.
 */
export function cleanReviewText(text) {
  if (!text) return null;
  let t = text;

  // Strip emoji (Unicode emoji ranges)
  t = t.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  // Strip emoji-style star ratings at start: "⭐️⭐️⭐️ 5/5 —" or "★★★★★"
  t = t.replace(/^[★⭐️\s]*\d\/\d\s*[—–-]\s*/i, '');

  // Do NOT fix spelling/grammar — reviews must be verbatim per ACL compliance.
  // Typos read as authentic; corrections risk "misquoted testimonial" under s.29(1)(e).

  // Fix double periods (formatting artefact, not content change)
  t = t.replace(/\.{2,}/g, '.');
  // Fix space before period/exclamation (formatting artefact)
  t = t.replace(/\s+([.!?])/g, '$1');

  // Spam detection: nonsensical word salad specific to known spam patterns.
  // Keep this list tight — false positives skip legitimate businesses.
  const spamPatterns = [
    /radish rainbow row/i,
    /root raves/i,
    /buffer-bulb buffers/i,
    /porch radish/i,
    /row-rowed leak pipes/i,
  ];
  for (const p of spamPatterns) {
    if (p.test(t)) return null;  // spam detected
  }

  return t.trim() || null;
}

// ─── Negative sentiment filter ────────────────────────────────────────────────

/**
 * Sentences containing negative sentiment that would undermine a positive ad.
 * These get filtered from quote selection.
 */
const NEGATIVE_PATTERNS = /\b(three times the|overcharged|too expensive|rip off|rip-off|ripoff|wouldn't recommend|not recommend|don't recommend|wasn't happy|wasn't going to be happy|was not happy|disappointed|terrible|horrible|awful|worst|waste of|charged too|not worth|didn't fix|didn't solve|still broken|came back|returned within|returning within|proved to be persistent|not infected|was not infected|weren't found|no .{0,20} found|luckily .{0,30} not|wanted to charge|another company|lol|lmao|haha|rofl)\b/i;

/**
 * Extract up to two short complete-sentence quotes from a review.
 * Finds all sentences ≤80 chars; returns the first two (or repeats the first).
 * Falls back to a single 75-char truncation if no short sentences found.
 *
 * @param {string} review
 * @returns {[string, string]}
 */
/**
 * Extract up to n display-ready quote strings from a review.
 * Prefers short sentences (≤90 chars), falls back to medium (≤140), then truncates.
 * Always returns exactly n strings (repeats last quote if review is thin).
 */
/**
 * Extract up to n complete sentences from a review for use as spoken voiceovers.
 * Never truncates mid-sentence — only returns complete sentences.
 * Prefers short (≤15 words), then medium (≤25 words), then any complete sentence.
 * If fewer than n complete sentences exist, repeats the best ones to fill.
 */
/**
 * Extract up to n spoken-quote strings from a review.
 * Target: ≤15 words per quote so audio fits within a 5s clip at ~180wpm.
 * Never truncates mid-word; prefers natural sentence or clause boundaries.
 * Falls back to repeating earlier quotes if the review is short.
 */
// Sentence openers that produce weak or confusing standalone subtitles:
// - mid-thought continuations ("As a...", "From the moment...", "Not only...")
// - meta-praise openers that don't describe anything specific ("I cannot speak highly enough...")
const DANGLING_OPENERS = /^(as a |as an |as someone|as (the|they|it|we|you|he|she|i |one |many |much |soon |expected|mentioned|stated|noted|promised|agreed|required|needed)|with a |with an |from the |from their |not only |moreover,|furthermore,|in addition,|additionally,|on top of that,|what's more,|to top it off,|besides,|overall,|overall i|in summary|in short,|in conclusion|to summarise|to summarize|needless to say|suffice to say|i cannot speak|i can('t| not) speak|i can not say enough|i would (highly )?recommend|i am (very |so |absolutely |extremely |truly |beyond )?happy|i am (very |so |absolutely |extremely |truly |beyond )?pleased|i am (very |so |absolutely |extremely |truly |beyond )?satisfied|i am (very |so |absolutely |extremely |truly )?(impressed|grateful|thankful)|i('m| am) very |however |however,|having |being |after |before |when |once |within |by the end|at the end|despite |although |even though |while |during |throughout |because |because of |thanks to |due to |given (that|the|their|his|her)|since then|following |since (the|their|my)|if (the|they|we|you|it|he|she|i )|this (means|is|gave|was)|they (also|even|really)|the (team|service|work|results|process)|and (the|they|it|their)|but (the|they|it)|which (was|is|made)|what (really|i|made)|i also |i added |i didn't know|we (also|later|then)|living in |upon |whether |whereas |\d+ \w+ \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;

export function extractQuotes(review, n = 2) {
  let cleaned = review
    .replace(/\(incl\.\s*/gi, 'including ')
    .replace(/\(e\.g\.\s*/gi, 'for example ')
    .replace(/\(i\.e\.\s*/gi, 'that is ')
    .replace(/\(approx\.\s*/gi, 'approximately ')
    // Remove any remaining unmatched opening parens (prevents mid-paren splits)
    .replace(/\([^)]*$/gm, '')
    // Strip parentheses entirely — content stays, brackets go
    .replace(/[()]/g, '');

  // Split on sentence-ending punctuation, then further split long sentences on dashes
  const rawSentences = (cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned]).map(s => s.trim());
  const sentences = rawSentences
    .flatMap(s => {
      // If a sentence is >25 words and contains a dash clause, split on the dash
      if (s.trim().split(/\s+/).length > 25 && /\s[-–—]\s/.test(s)) {
        return s.split(/\s[-–—]\s/).map(c => c.trim().replace(/[.!?]+$/, '') + '.');
      }
      return [s];
    })
    .filter(s => s.length >= 15)
    .filter(s => !DANGLING_OPENERS.test(s))    // reject mid-thought continuations
    .filter(s => !NEGATIVE_PATTERNS.test(s));   // reject negative sentiment
  const wc = s => s.trim().split(/\s+/).length;

  // Fit a sentence into maxWords — only truncate genuinely long sentences (>22 words).
  // Shorter sentences are always returned whole even if above the "preferred" length,
  // since a complete thought is always better than a truncated one.
  function fitToMaxWords(s, maxWords = 22) {
    if (wc(s) <= maxWords) return s;
    const words = s.trim().split(/\s+/);

    const cut = (i) => words.slice(0, i).join(' ').replace(/[,;]$/, '') + '...';

    // Scan in priority order — strongest break type first across ALL positions,
    // then fall back to weaker break types. This ensures "due" at i=11 wins
    // over "the" at i=19 because subordinate > article.

    // P1: After a comma or semicolon
    for (let i = maxWords; i >= 8; i--) {
      if (/[,;]$/.test(words[i - 1])) return cut(i);
    }
    // P2: Before a subordinate clause starter (main thought is already complete)
    for (let i = maxWords; i >= 8; i--) {
      if (/^(due|because|since|although|though|where|which|who|whom|whose|that|whereby|whereas|unless|until|once|whether|if|so|yet|even|especially|particularly|regardless)$/i.test(words[i])) {
        // "even if", "even though", "even when" — cut before "even" not between them
        if (/^(if|though|when)$/i.test(words[i]) && i > 8 && /^even$/i.test(words[i - 1])) return cut(i - 1);
        return cut(i);
      }
    }
    // P3: Before a coordinating conjunction or preposition
    for (let i = maxWords; i >= 8; i--) {
      if (/^(and|but|or|nor|for|including|with|without|from|into|through|after|before|during|while|when)$/i.test(words[i])) return cut(i);
    }
    // P4: Before an article (weakest break)
    for (let i = maxWords; i >= 8; i--) {
      if (/^(the|a|an)$/i.test(words[i])) return cut(i);
    }
    // No natural break — cut at maxWords
    return words.slice(0, maxWords).join(' ') + '...';
  }

  // Strongly prefer COMPLETE sentences (no truncation). Only use truncated
  // versions as a last resort — the proofreader flags "..." endings as dangling thoughts.
  const complete = sentences.filter(s => wc(s) <= 22);  // fits without truncation
  const fitted   = sentences.map(s => fitToMaxWords(s)); // truncated fallbacks

  const shortComplete  = complete.filter(s => wc(s) <= 15);
  const mediumComplete = complete.filter(s => wc(s) <= 22);

  // Priority: short complete → medium complete → any complete → truncated → raw review
  const pool = shortComplete.length >= n ? shortComplete
    : mediumComplete.length >= n ? mediumComplete
    : complete.length >= n ? complete
    : fitted.length >= n ? fitted
    : fitted.length ? fitted
    : [fitToMaxWords(review)];

  // Fill n slots without repeating — cycle only if we must (pool < n)
  const results = [];
  for (let i = 0; i < n; i++) {
    // Prefer unique sentences; only wrap around once all are used
    results.push(pool[i % pool.length]);
  }

  // Deduplicate: replace repeated entries with next unused pool entry
  for (let i = 1; i < results.length; i++) {
    if (results.slice(0, i).includes(results[i])) {
      const used = new Set(results.slice(0, i));
      const next = pool.find(s => !used.has(s));
      if (next) results[i] = next;
    }
  }

  return results;
}

/**
 * Trim text to at most n words, appending ellipsis only if truncated.
 */
export function trimToWords(text, n) {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return words.slice(0, n).join(' ') + '...';
}

export function extractTwoQuotes(review) {
  // Split on sentence-ending punctuation, keep the punctuation
  const sentences = (review.match(/[^.!?]+[.!?]+/g) || []).map(s => s.trim());

  // Prefer short sentences (≤80 chars) for both slots
  const short = sentences.filter(s => s.length >= 20 && s.length <= 80);
  if (short.length >= 2) return [short[0], short[1]];

  // Fall back: allow up to 120 chars for the second slot to avoid repeating
  const medium = sentences.filter(s => s.length >= 20 && s.length <= 120);
  if (short.length === 1 && medium.length >= 2) return [short[0], medium[1]];
  if (medium.length >= 2) return [medium[0], medium[1]];
  if (medium.length === 1) {
    // One usable sentence — truncate it for q1, use full for q2
    const full = medium[0];
    const brief = full.length > 75
      ? full.substring(0, full.lastIndexOf(' ', 75)) + '...'
      : full;
    return [brief, full];
  }

  // No complete sentences — truncate the review at word boundary
  const brief = review.length > 75
    ? review.substring(0, review.lastIndexOf(' ', 75)) + '...'
    : review;
  const longer = review.length > 120
    ? review.substring(0, review.lastIndexOf(' ', 120)) + '...'
    : review;
  return [brief, longer];
}

/**
 * Extract a sentence from text starting at `offset`.
 * Returns the first sentence of 20–80 chars, or up to 75 chars with ellipsis.
 */
export function extractSentence(text, offset = 0) {
  const slice = text.substring(offset).trim();
  const match = slice.match(/^[^.!?]{20,80}[.!?]/);
  return match ? match[0] : slice.substring(0, 75) + (slice.length > 75 ? '...' : '');
}

/** Round to 2 decimal places to avoid floating-point noise in Shotstack payloads. */
function round2(n) { return Math.round(n * 100) / 100; }

/** Build cumulative start-time array from scenes. */
export function cumulativeStarts(scenes) {
  return scenes.reduce((acc, s, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + scenes[i - 1].duration);
    return acc;
  }, []);
}
