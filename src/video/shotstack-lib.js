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
 * Build 5 aligned scene/voiceover pairs from a prospect's review.
 *
 * Each scene has matching on-screen text and a voiceover segment so they stay
 * in sync. Duration is derived from the voiceover word count at ~180 wpm
 * (ElevenLabs Charlie pace) with a minimum per scene for visual comfort.
 *
 * Scenes:
 *   1. Hook    — spoken: "Here's what [name] customers are saying in [city]."
 *                shown:  "What customers say about\n{name}"
 *   2. Quote 1 — spoken + shown: first short sentence of review (≤80 chars)
 *   3. Quote 2 — spoken + shown: second short sentence (≤80 chars), falls back to q1
 *   4. Stars   — spoken: "Five stars — [reviewer]."
 *                shown:  "⭐⭐⭐⭐⭐\n— {reviewer}"
 *   5. CTA     — spoken: "{name} — trusted by locals. Book today."
 *                shown:  "{name}\n{city} | Book Now"
 *
 * @param {{ business_name: string, city?: string, best_review_author?: string, best_review_text?: string }} prospect
 * @returns {Array<{ text: string, voiceover: string, duration: number }>}
 */
export function buildScenes(prospect) {
  const name = businessName(prospect.business_name);
  const city = prospect.city || 'Sydney';
  const reviewer = prospect.best_review_author || 'a customer';
  const review = (prospect.best_review_text || '').replace(/\s+/g, ' ').trim();
  const phone = prospect.phone || null;

  const quotes = extractTwoQuotes(review);

  const ctaText = phone ? `${name}\nCall ${phone}` : `${name}\n${city} | Book Now`;
  const nameHasCity = name.toLowerCase().includes(city.toLowerCase());
  const ctaVoiceover = phone
    ? `"${name}" — call us now on ${phone}.`
    : nameHasCity
      ? `"${name}" — trusted by locals. Book your service today.`
      : `"${name}" — trusted by locals across ${city}. Book your service today.`;

  const pairs = [
    {
      // Quotes around name in voiceover help ElevenLabs pronounce it as a proper noun.
      // No quotes in on-screen text.
      text:      `What customers say about\n${name}`,
      voiceover: `Here's what "${name}" customers are saying.`,
      minDur:    3,
    },
    {
      text:      `"${quotes[0]}"`,
      voiceover: quotes[0],
      minDur:    3,
    },
    {
      text:      `"${quotes[1]}"`,
      voiceover: quotes[1],
      minDur:    3,
    },
    {
      text:      `⭐⭐⭐⭐⭐\n— ${reviewer}`,
      voiceover: `Five stars — from ${reviewer}.`,
      minDur:    3,
    },
    {
      text:      ctaText,
      voiceover: ctaVoiceover,
      minDur:    4,
    },
  ];

  // Derive each scene's duration from its voiceover word count, then
  // scale all durations so they sum to the full voiceover length.
  // This keeps clips in sync even when individual estimates drift.
  const raw = pairs.map(({ text, voiceover, minDur }) => ({
    text,
    voiceover,
    dur: Math.max(minDur, sceneDuration(voiceover)),
  }));

  const fullScript = raw.map(s => s.voiceover).join('  ');
  const totalEstimated = raw.reduce((s, r) => s + r.dur, 0);
  // Add 3s tail so audio never gets cut off at the end of the last clip.
  const fullDuration = sceneDuration(fullScript) + 3;
  const scale = fullDuration / totalEstimated;

  return raw.map(({ text, voiceover, dur }) => ({
    text,
    voiceover,
    duration: Math.max(3, Math.round(dur * scale)),
  }));
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
  'pest control':   'cockroaches',
  'house cleaning': 'greasy-rangehood',
  'cleaning':       'greasy-rangehood',
  'plumber':        'blocked-drain',
};

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
export function pickClipsFromPool(niche, seed = 0) {
  const problem     = NICHE_ALIASES[niche] || niche;
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

  const slots = ['hook', 'technician', 'treatment', 'resolution', 'cta'];
  if (slots.some(s => !resolveSlot(s).length)) return null;

  return slots.map((slot, i) => {
    const arr   = resolveSlot(slot);
    const entry = arr[(seed + i) % arr.length];
    // Apply runtime focus override if the user has annotated this clip
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

/**
 * Extract up to two short complete-sentence quotes from a review.
 * Finds all sentences ≤80 chars; returns the first two (or repeats the first).
 * Falls back to a single 75-char truncation if no short sentences found.
 *
 * @param {string} review
 * @returns {[string, string]}
 */
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
