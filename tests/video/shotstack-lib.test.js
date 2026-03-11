import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceoverScript,
  buildSceneTexts,
  buildRenderPayload,
  pickClipsFromPool,
  businessName,
  extractSentence,
  cumulativeStarts,
  CLIP_POOLS,
  PEXELS_FALLBACK_QUERIES,
} from '../../src/video/shotstack-lib.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_PROSPECT = {
  business_name: 'BugFree Pest Control',
  city: 'Auburn',
  best_review_author: 'Cathy Zhuang',
  best_review_text: 'I had a fantastic experience with the pest control service today. Jack was incredibly professional, patient, and thorough from start to finish. He took the time to check every corner carefully and made sure the entire house was treated properly. Jack listened attentively and made me feel confident the problem would be solved.',
  niche: 'pest control',
};

const PIPED_NAME_PROSPECT = {
  business_name: 'Iconic Pest Solutions | Termite & General Exterminators | Termite Specialists in Sydney',
  city: 'Balmain East',
  best_review_author: 'Marlou Santos',
  best_review_text: 'We had a huntsman spider issue. Adam came out within 24 hours. He investigated the entire house.',
  niche: 'pest control',
};

const MINIMAL_PROSPECT = {
  business_name: 'Acme Services',
};

const LONG_REVIEW_PROSPECT = {
  business_name: 'Masters Pest Control',
  city: 'Sydney',
  best_review_author: 'Sal C',
  best_review_text: 'A'.repeat(400),
};

// ─── businessName ─────────────────────────────────────────────────────────────

describe('businessName', () => {
  it('returns the part before a pipe separator', () => {
    assert.equal(
      businessName('Iconic Pest Solutions | Termite & General Exterminators'),
      'Iconic Pest Solutions'
    );
  });

  it('returns the full name when no pipe present', () => {
    assert.equal(businessName('BugFree Pest Control'), 'BugFree Pest Control');
  });

  it('trims whitespace', () => {
    assert.equal(businessName('  Foo Bar  '), 'Foo Bar');
  });

  it('returns empty string for empty input', () => {
    assert.equal(businessName(''), '');
  });

  it('handles undefined gracefully', () => {
    assert.equal(businessName(undefined), '');
  });
});

// ─── extractSentence ──────────────────────────────────────────────────────────

describe('extractSentence', () => {
  it('extracts the first sentence within 20–100 chars', () => {
    const result = extractSentence('I had a fantastic experience with the pest control service today. Jack was great.');
    assert.equal(result, 'I had a fantastic experience with the pest control service today.');
  });

  it('truncates at 90 chars with ellipsis when no sentence boundary', () => {
    const long = 'A'.repeat(120);
    const result = extractSentence(long);
    assert.equal(result.length, 93); // 90 + '...'
    assert.ok(result.endsWith('...'));
  });

  it('starts from offset when provided', () => {
    const text = 'First sentence right here, and it ends now! Second sentence starts here and goes on further.';
    const first = extractSentence(text, 0);
    assert.ok(first.endsWith('!'));
    const second = extractSentence(text, first.length);
    assert.ok(second.startsWith('Second'));
  });

  it('handles text shorter than 90 chars with no sentence', () => {
    const short = 'No period here at all';
    const result = extractSentence(short);
    assert.equal(result, short); // no ellipsis needed, short enough
  });

  it('skips sentences shorter than 20 chars', () => {
    // "Hi." is only 3 chars — should not match the 20–100 pattern
    const result = extractSentence('Hi. This is a much longer sentence that qualifies as a proper sentence fragment.');
    assert.ok(result.length >= 20);
  });
});

// ─── cumulativeStarts ────────────────────────────────────────────────────────

describe('cumulativeStarts', () => {
  it('returns [0] for a single scene', () => {
    assert.deepEqual(cumulativeStarts([{ duration: 5 }]), [0]);
  });

  it('computes correct cumulative starts', () => {
    const scenes = [
      { duration: 5 },
      { duration: 12 },
      { duration: 10 },
      { duration: 7 },
      { duration: 7 },
    ];
    assert.deepEqual(cumulativeStarts(scenes), [0, 5, 17, 27, 34]);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(cumulativeStarts([]), []);
  });
});

// ─── buildVoiceoverScript ─────────────────────────────────────────────────────

describe('buildVoiceoverScript', () => {
  it('contains the business name', () => {
    const script = buildVoiceoverScript(FULL_PROSPECT);
    assert.ok(script.includes('BugFree Pest Control'));
  });

  it('contains the city', () => {
    const script = buildVoiceoverScript(FULL_PROSPECT);
    assert.ok(script.includes('Auburn'));
  });

  it('contains the reviewer name', () => {
    const script = buildVoiceoverScript(FULL_PROSPECT);
    assert.ok(script.includes('Cathy Zhuang'));
  });

  it('includes review text verbatim', () => {
    const script = buildVoiceoverScript(FULL_PROSPECT);
    assert.ok(script.includes('fantastic experience'));
  });

  it('uses only the first part of a piped business name', () => {
    const script = buildVoiceoverScript(PIPED_NAME_PROSPECT);
    assert.ok(script.includes('Iconic Pest Solutions'));
    assert.ok(!script.includes('Termite & General Exterminators'));
  });

  it('defaults city to Sydney when missing', () => {
    const script = buildVoiceoverScript(MINIMAL_PROSPECT);
    assert.ok(script.includes('Sydney'));
  });

  it('defaults reviewer to "a customer" when missing', () => {
    const script = buildVoiceoverScript(MINIMAL_PROSPECT);
    assert.ok(script.includes('a customer'));
  });

  it('trims long reviews to ≤320 chars at a sentence boundary', () => {
    const script = buildVoiceoverScript(LONG_REVIEW_PROSPECT);
    // The review quote portion ends with '...' or '.' — check total script is reasonable
    assert.ok(script.length < 600); // hook + trimmed quote + attribution + CTA
  });

  it('trims at sentence boundary, not mid-word', () => {
    const prospect = {
      ...FULL_PROSPECT,
      best_review_text: 'First sentence is here. ' + 'B'.repeat(300) + '.',
    };
    const script = buildVoiceoverScript(prospect);
    // Should cut at "First sentence is here." since remaining is too long
    assert.ok(script.includes('First sentence is here.'));
  });

  it('appends ellipsis when no sentence boundary found before 320 chars', () => {
    const script = buildVoiceoverScript(LONG_REVIEW_PROSPECT);
    assert.ok(script.includes('...'));
  });

  it('returns a non-empty string for minimal prospect', () => {
    const script = buildVoiceoverScript(MINIMAL_PROSPECT);
    assert.ok(typeof script === 'string' && script.length > 0);
  });
});

// ─── buildSceneTexts ─────────────────────────────────────────────────────────

describe('buildSceneTexts', () => {
  it('returns exactly 5 scenes', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    assert.equal(scenes.length, 5);
  });

  it('each scene has text and duration', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    for (const s of scenes) {
      assert.ok(typeof s.text === 'string' && s.text.length > 0);
      assert.ok(typeof s.duration === 'number' && s.duration > 0);
    }
  });

  it('scene 1 is the hook with business name', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    assert.ok(scenes[0].text.includes('BugFree Pest Control'));
    assert.ok(scenes[0].text.toLowerCase().includes('customers'));
  });

  it('scenes 2 and 3 contain quoted review text', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    assert.ok(scenes[1].text.startsWith('"'));
    assert.ok(scenes[2].text.startsWith('"'));
  });

  it('scene 4 contains 5 stars and reviewer name', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    assert.ok(scenes[3].text.includes('⭐'));
    assert.ok(scenes[3].text.includes('Cathy Zhuang'));
  });

  it('scene 5 is the CTA with city and Book Now', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    assert.ok(scenes[4].text.includes('Auburn'));
    assert.ok(scenes[4].text.includes('Book Now'));
  });

  it('scene durations sum to 41s', () => {
    const scenes = buildSceneTexts(FULL_PROSPECT);
    const total = scenes.reduce((s, sc) => s + sc.duration, 0);
    assert.equal(total, 41);
  });

  it('uses only the first part of a piped business name', () => {
    const scenes = buildSceneTexts(PIPED_NAME_PROSPECT);
    assert.ok(scenes[0].text.includes('Iconic Pest Solutions'));
    assert.ok(!scenes[0].text.includes('|'));
  });

  it('falls back to scene 2 quote when scene 3 quote is empty', () => {
    const prospect = { ...FULL_PROSPECT, best_review_text: 'Short review.' };
    const scenes = buildSceneTexts(prospect);
    // Both scenes 2 and 3 should have content
    assert.ok(scenes[1].text.length > 0);
    assert.ok(scenes[2].text.length > 0);
  });
});

// ─── buildRenderPayload ───────────────────────────────────────────────────────

const MOCK_CLIPS = [
  'https://example.com/clip1.mp4',
  'https://example.com/clip2.mp4',
  'https://example.com/clip3.mp4',
  'https://example.com/clip4.mp4',
  'https://example.com/clip5.mp4',
];
const MOCK_AUDIO = 'https://example.com/audio.mp3';
const MOCK_SCENES = buildSceneTexts(FULL_PROSPECT);

describe('buildRenderPayload', () => {
  it('returns correct output dimensions (1080x1920)', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    assert.equal(payload.output.size.width, 1080);
    assert.equal(payload.output.size.height, 1920);
  });

  it('output format is mp4', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    assert.equal(payload.output.format, 'mp4');
  });

  it('has 3 tracks without logo', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    assert.equal(payload.timeline.tracks.length, 3);
  });

  it('has 4 tracks with logo', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, 'https://example.com/logo.png');
    assert.equal(payload.timeline.tracks.length, 4);
  });

  it('video clips have volume 0 (muted)', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const videoTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'video')
    );
    for (const clip of videoTrack.clips) {
      assert.equal(clip.asset.volume, 0);
    }
  });

  it('video clips use cover fit', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const videoTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'video')
    );
    for (const clip of videoTrack.clips) {
      assert.equal(clip.fit, 'cover');
    }
  });

  it('audio track spans full duration', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const audioTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'audio')
    );
    const totalDuration = MOCK_SCENES.reduce((s, sc) => s + sc.duration, 0);
    assert.equal(audioTrack.clips[0].length, totalDuration);
    assert.equal(audioTrack.clips[0].start, 0);
  });

  it('audio track uses provided URL', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const audioTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'audio')
    );
    assert.equal(audioTrack.clips[0].asset.src, MOCK_AUDIO);
  });

  it('video clip count matches scene count', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const videoTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'video')
    );
    assert.equal(videoTrack.clips.length, MOCK_SCENES.length);
  });

  it('text clip count matches scene count', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const textTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'text')
    );
    assert.equal(textTrack.clips.length, MOCK_SCENES.length);
  });

  it('clip start times are cumulative', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const videoTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'video')
    );
    const starts = videoTrack.clips.map(c => c.start);
    assert.equal(starts[0], 0);
    assert.equal(starts[1], MOCK_SCENES[0].duration);
    assert.equal(starts[2], MOCK_SCENES[0].duration + MOCK_SCENES[1].duration);
  });

  it('text overlays start 0.5s after the video clip', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const textTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'text')
    );
    const videoTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'video')
    );
    for (let i = 0; i < MOCK_SCENES.length; i++) {
      assert.equal(textTrack.clips[i].start, videoTrack.clips[i].start + 0.5);
    }
  });

  it('uses fallback clip URL when a clip is null', () => {
    const clipsWithNull = [...MOCK_CLIPS];
    clipsWithNull[2] = null;
    const payload = buildRenderPayload(clipsWithNull, MOCK_AUDIO, MOCK_SCENES);
    const videoTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'video')
    );
    assert.ok(videoTrack.clips[2].asset.src.includes('shotstack-assets'));
  });

  it('logo track is first (rendered on top) when provided', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, 'https://example.com/logo.png');
    const firstTrackClip = payload.timeline.tracks[0].clips[0];
    assert.equal(firstTrackClip.asset.type, 'image');
    assert.equal(firstTrackClip.asset.src, 'https://example.com/logo.png');
  });

  it('logo clip is positioned on the CTA scene', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, 'https://example.com/logo.png');
    const logoTrack = payload.timeline.tracks[0];
    const expectedCtaStart = MOCK_SCENES.slice(0, -1).reduce((s, sc) => s + sc.duration, 0);
    assert.equal(logoTrack.clips[0].start, expectedCtaStart + 0.5);
  });

  it('text background uses valid hex color (not alpha hex)', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const textTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'text')
    );
    for (const clip of textTrack.clips) {
      const color = clip.asset.background.color;
      // Must be 7-char hex (#RRGGBB), not 9-char alpha hex
      assert.match(color, /^#[0-9a-fA-F]{6}$/);
    }
  });
});

// ─── pickClipsFromPool ────────────────────────────────────────────────────────

describe('pickClipsFromPool', () => {
  it('returns null when pool slots are empty', () => {
    assert.equal(pickClipsFromPool('pest control', 0), null);
  });

  it('returns null for unknown niche when default pool is also empty', () => {
    assert.equal(pickClipsFromPool('plumbing', 0), null);
  });

  it('returns 5 URLs when all slots are populated', () => {
    // Temporarily populate the pool for this test
    const pool = CLIP_POOLS['pest control'];
    const original = {};
    for (const slot of ['hook', 'technician', 'treatment', 'resolution', 'cta']) {
      original[slot] = pool[slot];
      pool[slot] = [`https://example.com/${slot}.mp4`];
    }

    const clips = pickClipsFromPool('pest control', 0);
    assert.ok(Array.isArray(clips));
    assert.equal(clips.length, 5);

    // Restore
    for (const slot of Object.keys(original)) pool[slot] = original[slot];
  });

  it('rotates clips based on seed', () => {
    const pool = CLIP_POOLS['pest control'];
    const original = {};
    for (const slot of ['hook', 'technician', 'treatment', 'resolution', 'cta']) {
      original[slot] = pool[slot];
      pool[slot] = [`https://example.com/${slot}-a.mp4`, `https://example.com/${slot}-b.mp4`];
    }

    const clipsAt0 = pickClipsFromPool('pest control', 0);
    const clipsAt1 = pickClipsFromPool('pest control', 1);
    // With seed rotation, at least some clips should differ
    assert.ok(clipsAt0.some((c, i) => c !== clipsAt1[i]));

    for (const slot of Object.keys(original)) pool[slot] = original[slot];
  });

  it('falls back to default pool for unknown niche', () => {
    const pool = CLIP_POOLS.default;
    const original = {};
    for (const slot of ['hook', 'technician', 'treatment', 'resolution', 'cta']) {
      original[slot] = pool[slot];
      pool[slot] = [`https://example.com/default-${slot}.mp4`];
    }

    const clips = pickClipsFromPool('unknown niche', 0);
    assert.ok(Array.isArray(clips));
    assert.equal(clips.length, 5);

    for (const slot of Object.keys(original)) pool[slot] = original[slot];
  });
});

// ─── PEXELS_FALLBACK_QUERIES ──────────────────────────────────────────────────

describe('PEXELS_FALLBACK_QUERIES', () => {
  it('has 5 queries for pest control', () => {
    assert.equal(PEXELS_FALLBACK_QUERIES['pest control'].length, 5);
  });

  it('has 5 queries for default', () => {
    assert.equal(PEXELS_FALLBACK_QUERIES.default.length, 5);
  });

  it('all queries are non-empty strings', () => {
    for (const queries of Object.values(PEXELS_FALLBACK_QUERIES)) {
      for (const q of queries) {
        assert.ok(typeof q === 'string' && q.length > 0);
      }
    }
  });
});
