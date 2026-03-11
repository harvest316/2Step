import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScenes,
  buildVoiceoverScript,
  buildSceneTexts,
  buildRenderPayload,
  pickClipsFromPool,
  clipsBySource,
  businessName,
  extractSentence,
  cumulativeStarts,
  sceneDuration,
  timingsToSceneDurations,
  stripSsml,
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

  it('truncates at 75 chars with ellipsis when no sentence boundary', () => {
    const long = 'A'.repeat(120);
    const result = extractSentence(long);
    assert.equal(result.length, 78); // 75 + '...'
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

// ─── sceneDuration ────────────────────────────────────────────────────────────

describe('sceneDuration', () => {
  it('returns at least 2s for very short text', () => {
    assert.ok(sceneDuration('Hi.') >= 2);
  });

  it('returns more seconds for longer text', () => {
    const short = sceneDuration('Hi.');
    const long = sceneDuration('This is a much longer sentence with many more words that will take longer to read aloud.');
    assert.ok(long > short);
  });

  it('returns a number', () => {
    assert.equal(typeof sceneDuration('Hello world.'), 'number');
  });
});

// ─── buildScenes ──────────────────────────────────────────────────────────────

describe('buildScenes', () => {
  it('returns exactly 5 scenes', () => {
    assert.equal(buildScenes(FULL_PROSPECT).length, 5);
  });

  it('each scene has text, voiceover, and duration', () => {
    for (const s of buildScenes(FULL_PROSPECT)) {
      assert.ok(typeof s.text === 'string' && s.text.length > 0);
      assert.ok(typeof s.voiceover === 'string' && s.voiceover.length > 0);
      assert.ok(typeof s.duration === 'number' && s.duration > 0);
    }
  });

  it('scene 1 text is the hook with business name', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[0].text.includes('BugFree Pest Control'));
    assert.ok(scenes[0].text.toLowerCase().includes('customers'));
  });

  it('scene 1 voiceover contains name', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[0].voiceover.includes('BugFree Pest Control'));
  });

  it('scenes 2 and 3 text contain quoted review text', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[1].text.startsWith('"'));
    assert.ok(scenes[2].text.startsWith('"'));
  });

  it('scenes 2 and 3 voiceover matches the quoted text (without quotes)', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[1].voiceover.includes('fantastic experience'));
  });

  it('scene 4 text contains 5 stars and reviewer name', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[3].text.includes('⭐'));
    assert.ok(scenes[3].text.includes('Cathy Zhuang'));
  });

  it('scene 4 voiceover contains reviewer name', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[3].voiceover.includes('Cathy Zhuang'));
  });

  it('scene 5 text is the CTA with city and Book Now', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[4].text.includes('Auburn'));
    assert.ok(scenes[4].text.includes('Book Now'));
  });

  it('scene 5 voiceover is the CTA with city', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    assert.ok(scenes[4].voiceover.includes('Auburn'));
    assert.ok(scenes[4].voiceover.toLowerCase().includes('book'));
  });

  it('durations are derived from voiceover length (not hardcoded)', () => {
    const short = buildScenes({ ...FULL_PROSPECT, best_review_text: 'Great.' });
    const long  = buildScenes({ ...FULL_PROSPECT, best_review_text: 'This was an absolutely incredible pest control service. The technician was thorough and professional and I could not be happier with the result.' });
    // Scene 2 (quote 1) should be shorter for the short review
    assert.ok(short[1].duration <= long[1].duration);
  });

  it('uses only the first part of a piped business name', () => {
    const scenes = buildScenes(PIPED_NAME_PROSPECT);
    assert.ok(scenes[0].text.includes('Iconic Pest Solutions'));
    assert.ok(!scenes[0].text.includes('|'));
  });

  it('defaults city to Sydney in CTA text and reviewer to "a customer" for minimal prospect', () => {
    const scenes = buildScenes(MINIMAL_PROSPECT);
    assert.ok(scenes[4].text.includes('Sydney'));
    assert.ok(scenes[3].voiceover.includes('a customer'));
  });

  it('falls back to scene 2 quote when scene 3 quote is empty', () => {
    const scenes = buildScenes({ ...FULL_PROSPECT, best_review_text: 'Short review.' });
    assert.ok(scenes[1].text.length > 0);
    assert.ok(scenes[2].text.length > 0);
  });
});

// ─── buildVoiceoverScript ─────────────────────────────────────────────────────

describe('buildVoiceoverScript', () => {
  it('joins scene voiceovers into a single string', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    const script = buildVoiceoverScript(scenes);
    assert.ok(typeof script === 'string' && script.length > 0);
  });

  it('contains name, city, reviewer, and review text', () => {
    const scenes = buildScenes(FULL_PROSPECT);
    const script = buildVoiceoverScript(scenes);
    assert.ok(script.includes('BugFree Pest Control'));
    assert.ok(script.includes('Auburn'));
    assert.ok(script.includes('Cathy Zhuang'));
    assert.ok(script.includes('fantastic experience'));
  });

  it('uses only the first part of a piped business name', () => {
    const script = buildVoiceoverScript(buildScenes(PIPED_NAME_PROSPECT));
    assert.ok(script.includes('Iconic Pest Solutions'));
    assert.ok(!script.includes('Termite & General Exterminators'));
  });

  it('returns a non-empty string for minimal prospect', () => {
    const script = buildVoiceoverScript(buildScenes(MINIMAL_PROSPECT));
    assert.ok(typeof script === 'string' && script.length > 0);
  });
});

// ─── buildSceneTexts ─────────────────────────────────────────────────────────

describe('buildSceneTexts', () => {
  it('returns exactly 5 { text, duration } objects', () => {
    const sceneTexts = buildSceneTexts(buildScenes(FULL_PROSPECT));
    assert.equal(sceneTexts.length, 5);
    for (const s of sceneTexts) {
      assert.ok(typeof s.text === 'string');
      assert.ok(typeof s.duration === 'number');
      assert.equal(Object.keys(s).sort().join(','), 'duration,text');
    }
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
const MOCK_SCENES = buildSceneTexts(buildScenes(FULL_PROSPECT));

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

  it('has 3 tracks without logo or music', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    assert.equal(payload.timeline.tracks.length, 3);
  });

  it('has 4 tracks with logo only', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, 'https://example.com/logo.png');
    assert.equal(payload.timeline.tracks.length, 4);
  });

  it('has 4 tracks with music only', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, null, 'https://example.com/music.mp3');
    assert.equal(payload.timeline.tracks.length, 4);
  });

  it('has 5 tracks with logo and music', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, 'https://example.com/logo.png', 'https://example.com/music.mp3');
    assert.equal(payload.timeline.tracks.length, 5);
  });

  it('music track has low volume (0.12) and spans full duration', () => {
    const musicUrl = 'https://example.com/music.mp3';
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, null, musicUrl);
    const musicTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.src === musicUrl)
    );
    assert.ok(musicTrack, 'music track should exist');
    assert.equal(musicTrack.clips[0].asset.volume, 0.12);
    const totalDuration = MOCK_SCENES.reduce((s, sc) => s + sc.duration, 0);
    assert.equal(musicTrack.clips[0].length, totalDuration);
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

  it('logo track has 2 clips — hook and CTA scenes', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES, 'https://example.com/logo.png');
    const logoTrack = payload.timeline.tracks[0];
    assert.equal(logoTrack.clips.length, 2);
    // First clip is on the hook scene (starts at 0 + 0.5)
    assert.equal(logoTrack.clips[0].start, 0.5);
    // Second clip is on the CTA scene
    const expectedCtaStart = MOCK_SCENES.slice(0, -1).reduce((s, sc) => s + sc.duration, 0);
    assert.equal(logoTrack.clips[1].start, expectedCtaStart + 0.5);
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

  it('text positioned at bottom when clip focus is top', () => {
    const topFocusClips = MOCK_CLIPS.map(url => ({ url, focus: 'top' }));
    const payload = buildRenderPayload(topFocusClips, MOCK_AUDIO, MOCK_SCENES);
    const textTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'text')
    );
    assert.ok(textTrack.clips.every(c => c.position === 'bottom'));
  });

  it('text positioned at top when clip focus is bottom', () => {
    const bottomFocusClips = MOCK_CLIPS.map(url => ({ url, focus: 'bottom' }));
    const payload = buildRenderPayload(bottomFocusClips, MOCK_AUDIO, MOCK_SCENES);
    const textTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'text')
    );
    assert.ok(textTrack.clips.every(c => c.position === 'top'));
  });

  it('accepts plain string clips (backward compat) and defaults focus to center', () => {
    const payload = buildRenderPayload(MOCK_CLIPS, MOCK_AUDIO, MOCK_SCENES);
    const textTrack = payload.timeline.tracks.find(t =>
      t.clips.some(c => c.asset.type === 'text')
    );
    assert.ok(textTrack.clips.every(c => c.position === 'center'));
  });
});

// ─── stripSsml ────────────────────────────────────────────────────────────────

describe('stripSsml', () => {
  it('removes a phoneme tag, leaving spoken text', () => {
    assert.equal(
      stripSsml('<phoneme alphabet="ipa" ph="wəˈruŋɡə">Wahroonga</phoneme>'),
      'Wahroonga'
    );
  });

  it('passes plain text through unchanged', () => {
    assert.equal(stripSsml('Hello world.'), 'Hello world.');
  });

  it('removes multiple tags in a sentence', () => {
    assert.equal(
      stripSsml('Here\'s <phoneme alphabet="ipa" ph="wəˈruŋɡə">Wahroonga</phoneme> and <phoneme alphabet="ipa" ph="ˈpærəmætə">Parramatta</phoneme>.'),
      'Here\'s Wahroonga and Parramatta.'
    );
  });

  it('handles empty string', () => {
    assert.equal(stripSsml(''), '');
  });
});

// ─── timingsToSceneDurations ──────────────────────────────────────────────────

describe('timingsToSceneDurations', () => {
  // Build a minimal synthetic alignment for a two-scene voiceover
  // voiceoverScript: "Hello world.  Goodbye."
  // scene 1 voiceover: "Hello world."
  // scene 2 voiceover: "Goodbye."
  const script = 'Hello world.  Goodbye.';
  const chars = script.replace(/\s/g, '').split(''); // only non-ws: Helloworld.Goodbye.
  // Assign start times: each char 100ms, each char lasts 100ms
  // Use seconds-based fields (matching actual ElevenLabs API response format)
  const startTimes = chars.map((_, i) => i * 0.1);    // 100ms per char in seconds
  const endTimes   = chars.map((_, i) => i * 0.1 + 0.1);
  const alignment = {
    characters: chars,
    character_start_times_seconds: startTimes,
    character_end_times_seconds: endTimes,
  };
  const scenes = [
    { voiceover: 'Hello world.' },
    { voiceover: 'Goodbye.' },
  ];

  it('returns an array with one duration per scene', () => {
    const durs = timingsToSceneDurations(scenes, script, alignment);
    assert.equal(durs.length, 2);
  });

  it('durations are numbers', () => {
    const durs = timingsToSceneDurations(scenes, script, alignment);
    assert.ok(durs.every(d => typeof d === 'number'));
  });

  it('minimum duration is 2s', () => {
    const shortScenes = [{ voiceover: 'Hi.' }];
    const shortScript = 'Hi.';
    const shortChars = ['H', 'i', '.'];
    const shortAlignment = {
      characters: shortChars,
      character_start_times_seconds: [0, 0.1, 0.2],
      character_end_times_seconds: [0.1, 0.2, 0.3],
    };
    const durs = timingsToSceneDurations(shortScenes, shortScript, shortAlignment);
    assert.ok(durs[0] >= 2);
  });

  it('longer voiceover text gets longer duration', () => {
    // 'Hello world.' has more chars than 'Goodbye.' → scene 1 end time is later
    const durs = timingsToSceneDurations(scenes, script, alignment);
    // Both should be >= 2s minimum; scene 1 should be >= scene 2
    assert.ok(durs[0] >= durs[1]);
  });

  it('falls back to 4s when alignment has no characters for a scene', () => {
    // A scene with an empty voiceover has 0 non-whitespace chars → no alignment entries → fallback
    const emptyScene = [{ voiceover: '   ' }];
    const durs = timingsToSceneDurations(emptyScene, '   ', alignment);
    assert.equal(durs[0], 4);
  });
});

// ─── pickClipsFromPool ────────────────────────────────────────────────────────

describe('pickClipsFromPool', () => {
  it('returns null for unknown niche when default pool is also empty', () => {
    assert.equal(pickClipsFromPool('plumbing', 0), null);
  });

  it('returns 5 {url, focus} objects for cockroaches (pool is populated)', () => {
    const clips = pickClipsFromPool('cockroaches', 0);
    assert.ok(Array.isArray(clips));
    assert.equal(clips.length, 5);
    assert.ok(clips.every(c => typeof c.url === 'string' && c.url.startsWith('https://')));
    assert.ok(clips.every(c => ['top', 'center', 'bottom'].includes(c.focus)));
  });

  it('maps pest control alias to cockroaches pool', () => {
    const clips = pickClipsFromPool('pest control', 0);
    assert.ok(Array.isArray(clips));
    assert.equal(clips.length, 5);
  });

  it('returns 5 URLs when all slots are populated (shared + specific)', () => {
    // Populate pest-specific slots (hook, treatment) and shared slots
    const specific = CLIP_POOLS['cockroaches'];
    const shared   = CLIP_POOLS['shared'];
    const origSpec = { hook: specific.hook, treatment: specific.treatment };
    const origShared = { technician: shared.technician, resolution: shared.resolution, cta: shared.cta };

    specific.hook      = [{ url: 'https://example.com/hook.mp4', source: 'kling' }];
    specific.treatment = [{ url: 'https://example.com/treatment.mp4', source: 'kling' }];
    shared.technician  = [{ url: 'https://example.com/technician.mp4', source: 'kling' }];
    shared.resolution  = [{ url: 'https://example.com/resolution.mp4', source: 'kling' }];
    shared.cta         = [{ url: 'https://example.com/cta.mp4', source: 'kling' }];

    const clips = pickClipsFromPool('cockroaches', 0);
    assert.ok(Array.isArray(clips));
    assert.equal(clips.length, 5);
    // Returns {url, focus} objects
    assert.ok(clips.every(c => typeof c.url === 'string'));

    // Restore
    Object.assign(specific, origSpec);
    Object.assign(shared, origShared);
  });

  it('rotates clips based on seed', () => {
    const specific = CLIP_POOLS['cockroaches'];
    const shared   = CLIP_POOLS['shared'];
    const origSpec = { hook: specific.hook, treatment: specific.treatment };
    const origShared = { technician: shared.technician, resolution: shared.resolution, cta: shared.cta };

    specific.hook      = [{ url: 'https://example.com/hook-a.mp4', source: 'kling' }, { url: 'https://example.com/hook-b.mp4', source: 'kling' }];
    specific.treatment = [{ url: 'https://example.com/treatment-a.mp4', source: 'kling' }, { url: 'https://example.com/treatment-b.mp4', source: 'kling' }];
    shared.technician  = [{ url: 'https://example.com/tech-a.mp4', source: 'kling' }, { url: 'https://example.com/tech-b.mp4', source: 'kling' }];
    shared.resolution  = [{ url: 'https://example.com/res-a.mp4', source: 'kling' }, { url: 'https://example.com/res-b.mp4', source: 'kling' }];
    shared.cta         = [{ url: 'https://example.com/cta-a.mp4', source: 'kling' }, { url: 'https://example.com/cta-b.mp4', source: 'kling' }];

    const clipsAt0 = pickClipsFromPool('cockroaches', 0);
    const clipsAt1 = pickClipsFromPool('cockroaches', 1);
    assert.ok(clipsAt0.some((c, i) => c.url !== clipsAt1[i].url));

    Object.assign(specific, origSpec);
    Object.assign(shared, origShared);
  });

  it('falls back to default pool for unknown niche', () => {
    const pool = CLIP_POOLS.default;
    const original = {};
    for (const slot of ['hook', 'technician', 'treatment', 'resolution', 'cta']) {
      original[slot] = pool[slot];
      pool[slot] = [{ url: `https://example.com/default-${slot}.mp4`, source: 'pexels' }];
    }

    const clips = pickClipsFromPool('unknown niche', 0);
    assert.ok(Array.isArray(clips));
    assert.equal(clips.length, 5);

    for (const slot of Object.keys(original)) pool[slot] = original[slot];
  });
});

// ─── clipsBySource ────────────────────────────────────────────────────────────

describe('clipsBySource', () => {
  it('returns empty array when no clips match source', () => {
    assert.deepEqual(clipsBySource('sora'), []);
  });

  it('returns kling clips (pool is populated)', () => {
    const results = clipsBySource('kling');
    assert.ok(results.length > 0);
    assert.ok(results.every(r => typeof r.niche === 'string'));
    assert.ok(results.every(r => typeof r.slot === 'string'));
    assert.ok(results.every(r => r.url.startsWith('https://')));
  });

  it('finds clips in shared pool', () => {
    const results = clipsBySource('kling');
    assert.ok(results.some(r => r.niche === 'shared' && r.slot === 'technician'));
  });

  it('filters by source — does not return clips from other sources', () => {
    const pool = CLIP_POOLS.default;
    const original = {};
    for (const slot of ['hook', 'treatment']) {
      original[slot] = pool[slot];
      pool[slot] = [{ url: `https://pexels.example.com/${slot}.mp4`, source: 'pexels' }];
    }

    const pexelsClips = clipsBySource('pexels');
    assert.ok(pexelsClips.every(c => c.url.includes('pexels.example.com')));

    for (const slot of Object.keys(original)) pool[slot] = original[slot];
  });

  it('searches across multiple niches', () => {
    const cockroachPool = CLIP_POOLS['cockroaches'];
    const defaultPool = CLIP_POOLS.default;
    const origCock = { hook: cockroachPool.hook };
    const origDefault = { hook: defaultPool.hook };

    cockroachPool.hook = [{ url: 'https://example.com/cock-hook.mp4', source: 'sora' }];
    defaultPool.hook   = [{ url: 'https://example.com/default-hook.mp4', source: 'sora' }];

    const results = clipsBySource('sora');
    const niches = [...new Set(results.map(r => r.niche))];
    assert.ok(niches.includes('cockroaches'));
    assert.ok(niches.includes('default'));

    cockroachPool.hook = origCock.hook;
    defaultPool.hook   = origDefault.hook;
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
