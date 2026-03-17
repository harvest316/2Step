/**
 * Pure functions for Shotstack video generation — no side effects, no I/O.
 * Imported by both shotstack.js (CLI) and tests.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FOCUS_OVERRIDES_PATH = resolve(__dirname, '../../clips/focus-overrides.json');

/**
 * Per-clip focus overrides loaded from clips/focus-overrides.json.
 * Keys are filenames (e.g. "blocked-drain-hook-a.mp4"), values are focus strings.
 * Edit that file after watching clips — no code change needed.
 */
const FOCUS_OVERRIDES = (() => {
  if (!existsSync(FOCUS_OVERRIDES_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(FOCUS_OVERRIDES_PATH, 'utf8'));
    // Strip comment keys
    return Object.fromEntries(
      Object.entries(raw).filter(([k]) => !k.startsWith('_'))
    );
  } catch { return {}; }
})();

// ─── Suburb phonetics ─────────────────────────────────────────────────────────
//
// ElevenLabs mispronounces many Australian suburb names. This map provides
// phonetic respellings to use in the TTS voiceover string.
// Key = canonical suburb name (case-insensitive match), value = phonetic form.
//
// Sources: local knowledge + Wiktionary where available.
// Add new entries as mispronunciations are discovered.

export const SUBURB_PHONETICS = {
  'Wahroonga':    'Wah-ROON-ga',
  'Artarmon':     'AR-tar-mon',
  'Turramurra':   'Turra-MURR-a',
  'Pymble':       'PIM-bul',
  'Killara':      'ki-LAR-a',
  'Epping':       'EP-ing',
  'Pennant Hills': 'PEN-ant Hills',
  'Beecroft':     'BEE-croft',
  'Cherrybrook':  'CHERRY-brook',
  'Ryde':         'Ryde',
  'Chatswood':    'CHATS-wood',
  'Parramatta':   'Para-MATTA',
  'Woolloomooloo': 'Wool-oo-moo-LOO',
  'Woollahara':   'Wool-a-RA',
  'Woollahra':    'Wool-a-RA',
  'Kirribilli':   'Kirri-BILLY',
  'Manly':        'MAN-lee',
  'Mosman':       'MOZ-man',
  'Neutral Bay':  'NEW-tral Bay',
  'Cremorne':     'cre-MORN',
  'Cammeray':     'KAM-er-ay',
  'Naremburn':    'NARE-burn',
  'Willoughby':   'WILL-oh-bee',
  'Castlecrag':   'CASTLE-krag',
  'Seaforth':     'SEA-forth',
  'Balgowlah':    'Bal-GOW-la',
  'Manly Vale':   'MAN-lee Vale',
  'Brookvale':    'BROOK-vale',
  'Dee Why':      'Dee Why',
  'Narrabeen':    'NARRA-been',
  'Mona Vale':    'MOH-na Vale',
  'Avalon Beach': 'AVA-lon Beach',
  'Terrey Hills': 'TERRY Hills',
  'Dural':        'DYOO-ral',
  'Galston':      'GAWL-ston',
  'Glenhaven':    'Glen-HAY-ven',
  'Kenthurst':    'KENT-hurst',
  'Annangrove':   'ANNA-grove',
  'Glenorie':     'Glen-OR-ee',
  'Point Piper':  'Point PIE-per',
  'Potts Point':  'Potts Point',
  'Haymarket':    'HAY-market',
  'The Rocks':    'The Rocks',
};

/**
 * Replace suburb name occurrences in a voiceover string with phonetic form.
 * Case-insensitive match; only applies to words in SUBURB_PHONETICS.
 *
 * Call this on each scene's voiceover string to guarantee consistent
 * pronunciation regardless of what Opus generates.
 *
 * @param {string} voiceover
 * @param {string} suburb  — canonical suburb name from DB
 * @returns {string}
 */
export function applyPhonetics(voiceover, suburb) {
  if (!suburb) return voiceover;
  // Find the phonetic form — try exact match then case-insensitive
  const key = Object.keys(SUBURB_PHONETICS).find(
    k => k.toLowerCase() === suburb.toLowerCase()
  );
  if (!key) return voiceover; // unknown suburb — leave as-is

  const phonetic = SUBURB_PHONETICS[key];
  // Replace all occurrences (case-insensitive) of the suburb name
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return voiceover.replace(new RegExp(escaped, 'gi'), phonetic);
}

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
 * @returns {Array<{ text: string, voiceover: string, duration: number }>}
 */
export function buildScenes(prospect) {
  const name     = businessName(prospect.business_name);
  const city     = prospect.city || 'Sydney';
  const niche    = (prospect.niche || '').toLowerCase();
  const reviewer = toTitleCase(prospect.best_review_author || 'a local');
  const review   = (prospect.best_review_text || '').replace(/\s+/g, ' ').trim();
  const phone    = prospect.phone || null;
  const rating   = prospect.google_rating ? Math.round(prospect.google_rating) : 5;
  const starsText = `${rating} Star${rating === 1 ? '' : 's'}`;
  const starsVoiceover = ['', 'One star', 'Two stars', 'Three stars', 'Four stars', 'Five stars'][rating] || `${rating} stars`;

  // Build niche-appropriate hook text
  let hookText, hookVoiceover;
  if (niche === 'plumber' || niche === 'plumbing') {
    hookText      = `Plumbing problems in ${city}?`;
    hookVoiceover = `Plumbing problems in ${city}?`;
  } else if (niche.includes('cleaning') || niche.includes('cleaner')) {
    hookText      = `Need a cleaner in ${city}?`;
    hookVoiceover = `Need a cleaner in ${city}?`;
  } else {
    // Pest control — detect specific pest
    const pest     = detectPestFromReview(review);
    const pestWord = pestLabel(pest);
    hookText      = `Dealing with ${pestWord} in ${city}?`;
    hookVoiceover = pest
      ? `Dealing with ${pestWord} in ${city}?`
      : `Looking for pest control in ${city}?`;
  }

  // Extract 4 COMPLETE sentences — no truncation, prefer ≤15 words, never cut mid-sentence
  const quotes = extractQuotes(review, 4);

  const ctaText = phone ? `${name}\nCall ${phone}` : `${name}\nFree Inspection`;
  const ctaVoiceover = phone
    ? `Call ${phone} or reply YES to schedule your free inspection.`
    : `Reply YES or visit "${name}" to schedule your free inspection.`;

  return [
    {
      text:      hookText,
      voiceover: hookVoiceover,
    },
    {
      text:      `"${quotes[0]}"`,
      voiceover: quotes[0],
    },
    {
      text:      `"${quotes[1]}"`,
      voiceover: quotes[1],
    },
    {
      text:      `"${quotes[2]}"`,
      voiceover: quotes[2],
    },
    {
      text:      `"${quotes[3]}"`,
      voiceover: quotes[3],
    },
    {
      text:      `${starsText}\n— ${reviewer}`,
      voiceover: `${starsVoiceover} — ${reviewer}.`,
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
  'pest control':          null, // no default — detectPestFromReview() must identify the pest, or render fails
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
  if (/termite/.test(t))                          return 'termites';
  if (/cockroach|roach/.test(t))                  return 'cockroaches';
  if (/spider/.test(t))                           return 'spiders';
  if (/\brat\b|\brats\b|\bmouse\b|\bmice\b|rodent/.test(t)) return 'rodents';
  return null;
}

/**
 * Human-readable pest label for voiceover ("termites", "cockroaches", etc.)
 */
export function pestLabel(problem) {
  return { termites: 'termites', cockroaches: 'cockroaches', spiders: 'spiders', rodents: 'rodents' }[problem] || 'pests';
}

// Maps problem slug → shared pool key for technician/resolution/cta
const PROBLEM_SHARED_POOL = {
  'cockroaches':     'shared',
  'rodents':         'shared',
  'spiders':         'shared',
  'termites':        'shared',
  'blocked-drain':   'plumbing-shared',
  'burst-pipe':      'plumbing-shared',
  'leaking-tap':     'plumbing-shared',
  'hot-water':       'plumbing-shared',
  'greasy-rangehood':'house-cleaning-shared',
  'dirty-bathroom':  'house-cleaning-shared',
  'end-of-lease':    'house-cleaning-shared',
  'deep-clean':      'house-cleaning-shared',
};

/**
 * Pick 5 clips (hook, technician, treatment, resolution, cta) for a given problem.
 *
 * @param {string} niche    Prospect niche (e.g. 'plumber', 'pest control', 'blocked-drain')
 * @param {number} seed     Rotates clip selection per prospect
 * @returns {Array<{url,focus}>|null}  5 clips, or null if any slot is empty
 */
export function pickClipsFromPool(niche, seed = 0, reviewText = '') {
  // For pest control, detect specific pest from review — no generic fallback
  const isPestControl = niche === 'pest control' || NICHE_ALIASES[niche] === null;
  const detected = isPestControl ? detectPestFromReview(reviewText) : null;
  const aliased = NICHE_ALIASES[niche];
  const problem = detected ?? (aliased !== null ? aliased : null) ?? niche;
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

  return slots.map((slot, i) => {
    const arr   = resolveSlot(baseSlot(slot));
    // Shift seed by ~half the pool size for *2 slots to get a different clip
    // Use a prime (7) so it doesn't alias with common pool sizes (5, 8)
    const offset = slot.endsWith('2') ? 7 : 0;
    const entry = arr[(seed + i + offset) % arr.length];
    const filename = entry.url.split('/').pop();
    const focus = FOCUS_OVERRIDES[filename] ?? entry.focus ?? 'center';
    return { url: entry.url, focus };
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
  plumbing: [
    'burst pipe water leak home',
    'plumber fixing pipes',
    'plumber repairing drain',
    'happy homeowner kitchen tap',
    'plumber handshake front door',
  ],
  'house-cleaning': [
    'messy cluttered living room',
    'professional cleaner home',
    'cleaner scrubbing bathroom',
    'sparkling clean home interior',
    'cleaner handshake front door',
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

export function toTitleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}

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
export function extractQuotes(review, n = 2) {
  const sentences = (review.match(/[^.!?]+[.!?]+/g) || [review]).map(s => s.trim()).filter(s => s.length >= 15);
  const wc = s => s.trim().split(/\s+/).length;

  // Fit a sentence into maxWords — split at a clause boundary (comma/semicolon/conjunction) if possible
  function fitToMaxWords(s, maxWords = 15) {
    if (wc(s) <= maxWords) return s;
    const words = s.trim().split(/\s+/);
    // Try to cut at a natural pause: comma, semicolon, or 'and'/'but'/'so' conjunction
    for (let i = maxWords; i >= 6; i--) {
      if (/[,;]$/.test(words[i - 1]) || /^(and|but|so|though|when|while|after|before)$/i.test(words[i])) {
        return words.slice(0, i).join(' ').replace(/[,;]$/, '') + '...';
      }
    }
    // No natural break — cut at maxWords with ellipsis so it reads as deliberate excerpt
    return words.slice(0, maxWords).join(' ') + '...';
  }

  const fitted = sentences.map(s => fitToMaxWords(s));
  const short  = fitted.filter(s => wc(s) <= 12);
  const medium = fitted.filter(s => wc(s) <= 15);
  const pool   = short.length >= n ? short : medium.length >= n ? medium : fitted.length ? fitted : [fitToMaxWords(review)];

  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(pool[i % pool.length]);
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
