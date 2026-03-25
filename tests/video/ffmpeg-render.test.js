/**
 * Unit tests for pure helper functions exported from ffmpeg-render.js.
 *
 * Tests:
 *   - escapeDrawtext: escapes special characters for ffmpeg drawtext filter
 *   - wordWrap: wraps text to a max character width, preserving explicit \n
 *   - buildDrawtext: builds the full drawtext filter string for a scene
 *   - buildVideoFilterChain: builds the video filter chain (scale/crop/concat/xfade)
 *   - Constants: W, H, DEJAVU_FONT
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeDrawtext,
  wordWrap,
  buildDrawtext,
  buildVideoFilterChain,
  W,
  H,
  DEJAVU_FONT,
} from '../../src/video/ffmpeg-render.js';

// ─── Constants ──────────────────────────────────────────────────────────────

describe('ffmpeg-render constants', () => {
  it('W is 1080 (9:16 vertical width)', () => {
    assert.equal(W, 1080);
  });

  it('H is 1920 (9:16 vertical height)', () => {
    assert.equal(H, 1920);
  });

  it('DEJAVU_FONT is the expected system font path', () => {
    assert.equal(DEJAVU_FONT, '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
  });
});

// ─── escapeDrawtext ─────────────────────────────────────────────────────────

describe('escapeDrawtext', () => {
  it('returns the same string when no special characters', () => {
    assert.equal(escapeDrawtext('Hello world'), 'Hello world');
  });

  it('escapes colons', () => {
    const result = escapeDrawtext('Time: 10:30');
    assert.ok(result.includes('\\:'), `Expected escaped colon in "${result}"`);
    assert.ok(!result.includes(':') || result.includes('\\:'));
  });

  it('escapes square brackets', () => {
    const result = escapeDrawtext('Test [value]');
    assert.ok(result.includes('\\['));
    assert.ok(result.includes('\\]'));
  });

  it('escapes semicolons', () => {
    const result = escapeDrawtext('a; b');
    assert.ok(result.includes('\\;'));
  });

  it('replaces single quotes with smart quotes', () => {
    const result = escapeDrawtext("it's great");
    assert.ok(!result.includes("'"), 'Should not have straight single quote');
    assert.ok(result.includes('\u2019'), 'Should have smart quote');
  });

  it('escapes percent signs by doubling them', () => {
    const result = escapeDrawtext('100% done');
    assert.ok(result.includes('%%'));
  });

  it('escapes backslashes', () => {
    const result = escapeDrawtext('path\\to\\file');
    assert.ok(result.includes('\\\\'));
  });

  it('handles empty string', () => {
    assert.equal(escapeDrawtext(''), '');
  });

  it('handles string with all special characters', () => {
    const result = escapeDrawtext("\\':[];%");
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('handles multiple colons', () => {
    const result = escapeDrawtext('a:b:c');
    const colonCount = (result.match(/\\:/g) || []).length;
    assert.equal(colonCount, 2);
  });

  it('preserves newlines', () => {
    const result = escapeDrawtext('Line 1\nLine 2');
    assert.ok(result.includes('\n'));
  });

  it('preserves spaces and tabs', () => {
    const result = escapeDrawtext('hello   world\there');
    assert.ok(result.includes('   '));
    assert.ok(result.includes('\t'));
  });
});

// ─── wordWrap ───────────────────────────────────────────────────────────────

describe('wordWrap', () => {
  it('does not wrap short text', () => {
    assert.equal(wordWrap('Hello world'), 'Hello world');
  });

  it('wraps text exceeding default 18-char limit', () => {
    const result = wordWrap('This is a very long sentence that exceeds the limit');
    const lines = result.split('\n');
    assert.ok(lines.length > 1, 'Should produce multiple lines');
    for (const line of lines) {
      assert.ok(line.length <= 20, `Line too long: "${line}" (${line.length} chars)`);
    }
  });

  it('preserves explicit newlines', () => {
    const result = wordWrap('Line one\nLine two');
    assert.ok(result.includes('\n'));
    const lines = result.split('\n');
    assert.ok(lines.some(l => l.includes('Line one')));
    assert.ok(lines.some(l => l.includes('Line two')));
  });

  it('respects custom maxChars parameter', () => {
    const result = wordWrap('one two three four five six', 10);
    const lines = result.split('\n');
    assert.ok(lines.length >= 3, `Expected >= 3 lines with maxChars=10, got ${lines.length}`);
  });

  it('handles single long word (no wrap possible)', () => {
    const result = wordWrap('Supercalifragilisticexpialidocious');
    // A single word that exceeds maxChars can't be wrapped, stays as-is
    assert.equal(result, 'Supercalifragilisticexpialidocious');
  });

  it('handles empty string', () => {
    assert.equal(wordWrap(''), '');
  });

  it('handles string with only spaces', () => {
    const result = wordWrap('   ');
    assert.equal(result, '');
  });

  it('handles multiple spaces between words (collapsed by split)', () => {
    const result = wordWrap('hello    world');
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('world'));
  });

  it('handles maxChars = 1', () => {
    const result = wordWrap('a b c', 1);
    const lines = result.split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines, ['a', 'b', 'c']);
  });

  it('handles text with exactly maxChars length', () => {
    const result = wordWrap('exactly 18 chars!?', 18);
    // Should fit on one line
    const lines = result.split('\n');
    assert.equal(lines.length, 1);
  });

  it('handles text with explicit newline and wrapping needed', () => {
    const result = wordWrap('Short\nThis is a longer paragraph that needs wrapping', 18);
    const lines = result.split('\n');
    assert.ok(lines[0] === 'Short');
    assert.ok(lines.length >= 3);
  });

  it('handles multiple explicit newlines', () => {
    const result = wordWrap('A\nB\nC');
    const lines = result.split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines, ['A', 'B', 'C']);
  });
});

// ─── buildDrawtext ──────────────────────────────────────────────────────────

describe('buildDrawtext', () => {
  const defaultVariant = {
    font: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    fontSize: 76,
    textColor: 'white',
    borderW: 2,
    borderColor: 'black',
    boxColor: 'black@0.55',
    boxBorderW: 20,
  };

  it('returns a string starting with "drawtext="', () => {
    const scene = { text: 'Hello', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.startsWith('drawtext='));
  });

  it('includes fontfile parameter', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes('fontfile='));
  });

  it('includes text parameter', () => {
    const scene = { text: 'Test text', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes("text='"));
  });

  it('includes enable between start and end time', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 2.5, 5.5, 'bottom', defaultVariant, 0);
    assert.ok(result.includes("enable='between(t,2.5,5.5)'"));
  });

  it('positions text at y=h*0.08 when clipFocus is top', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'top', defaultVariant, 0);
    assert.ok(result.includes('y=h*0.08'), `Expected y=h*0.08 in "${result}"`);
  });

  it('positions text at y=h*0.80-th when clipFocus is bottom or undefined', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes('y=h*0.80-th'));
  });

  it('uses DejaVu font for stars scene (index 5)', () => {
    const scene = { text: '5 Stars\nJohn Smith', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 5);
    assert.ok(result.includes('DejaVuSans-Bold.ttf'));
  });

  it('uses variant font for non-stars scenes', () => {
    const variant = { ...defaultVariant, font: '/custom/MyFont.ttf' };
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', variant, 0);
    assert.ok(result.includes('MyFont.ttf'));
  });

  it('replaces star count with star glyphs for scene index 5', () => {
    const scene = { text: '5 Stars\nJohn Smith', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 5);
    // The text should have ★★★★★ instead of "5 Stars"
    // After escaping, the stars should still be present (not affected by escapeDrawtext)
    assert.ok(result.includes('\u2605'), 'Should contain star glyphs');
  });

  it('replaces singular "Star" in stars scene', () => {
    const scene = { text: '1 Star\nAnonymous', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 5);
    assert.ok(result.includes('\u2605'));
  });

  it('does not replace star text for non-stars scenes', () => {
    const scene = { text: '5 Stars\nJohn Smith', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 2);
    // For non-stars scene, the text "5 Stars" should remain (escaped)
    assert.ok(!result.includes('\u2605') || result.includes('Stars'));
  });

  it('includes fontsize parameter', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes(':fontsize=76'));
  });

  it('includes fontcolor parameter', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes(':fontcolor=white'));
  });

  it('includes box parameters', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes(':box=1'));
    assert.ok(result.includes(':boxcolor=black@0.55'));
    assert.ok(result.includes(':boxborderw=20'));
  });

  it('includes border parameters', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes(':borderw=2'));
    assert.ok(result.includes(':bordercolor=black'));
  });

  it('centers text horizontally with x=(w-tw)/2', () => {
    const scene = { text: 'Test', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    assert.ok(result.includes(':x=(w-tw)/2'));
  });

  it('word-wraps the scene text before escaping', () => {
    const scene = { text: 'This is a very long text that should be word wrapped at eighteen chars', duration: 3 };
    const result = buildDrawtext(scene, 0, 3, 'bottom', defaultVariant, 0);
    // The text will have been word-wrapped, so newlines embedded
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

// ─── buildVideoFilterChain ──────────────────────────────────────────────────

describe('buildVideoFilterChain', () => {
  it('returns filterParts array and videoOutLabel string', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4', focus: 'bottom' }],
      scenes: [{ duration: 3 }],
      clipInputStart: 0,
      variant: { transition: 'none', transitionDuration: 0 },
      starts: [0],
    });
    assert.ok(Array.isArray(result.filterParts));
    assert.equal(typeof result.videoOutLabel, 'string');
  });

  it('produces concat filter for transition=none', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }, { url: 'b.mp4' }],
      scenes: [{ duration: 3 }, { duration: 4 }],
      clipInputStart: 0,
      variant: { transition: 'none', transitionDuration: 0 },
      starts: [0, 3],
    });
    const concatFilter = result.filterParts.find(f => f.includes('concat='));
    assert.ok(concatFilter, 'Should have a concat filter');
    assert.ok(concatFilter.includes('n=2'));
    assert.equal(result.videoOutLabel, 'vraw');
  });

  it('produces concat filter for single clip regardless of transition type', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }],
      scenes: [{ duration: 5 }],
      clipInputStart: 0,
      variant: { transition: 'xfade:fade', transitionDuration: 0.3 },
      starts: [0],
    });
    const concatFilter = result.filterParts.find(f => f.includes('concat='));
    assert.ok(concatFilter, 'Single clip should use concat, not xfade');
    assert.equal(result.videoOutLabel, 'vraw');
  });

  it('produces xfade filter chain for xfade:fade transition', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }, { url: 'b.mp4' }, { url: 'c.mp4' }],
      scenes: [{ duration: 3 }, { duration: 4 }, { duration: 3 }],
      clipInputStart: 0,
      variant: { transition: 'xfade:fade', transitionDuration: 0.3 },
      starts: [0, 3, 7],
    });
    const xfadeFilters = result.filterParts.filter(f => f.includes('xfade='));
    assert.equal(xfadeFilters.length, 2, 'Should have 2 xfade filters for 3 clips');
    assert.ok(xfadeFilters[0].includes('transition=fade'));
    assert.equal(result.videoOutLabel, 'vraw');
  });

  it('produces xfade filter chain for xfade:wipeleft transition', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }, { url: 'b.mp4' }],
      scenes: [{ duration: 3 }, { duration: 4 }],
      clipInputStart: 0,
      variant: { transition: 'xfade:wipeleft', transitionDuration: 0.25 },
      starts: [0, 3],
    });
    const xfadeFilters = result.filterParts.filter(f => f.includes('xfade='));
    assert.equal(xfadeFilters.length, 1);
    assert.ok(xfadeFilters[0].includes('transition=wipeleft'));
  });

  it('includes scale/crop/fps/tpad/trim filters per clip', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }, { url: 'b.mp4' }],
      scenes: [{ duration: 3 }, { duration: 4 }],
      clipInputStart: 2,
      variant: { transition: 'none', transitionDuration: 0 },
      starts: [0, 3],
    });
    // Check that clip input indices are correct
    assert.ok(result.filterParts[0].includes('[2:v]'), 'First clip should reference input 2');
    assert.ok(result.filterParts[1].includes('[3:v]'), 'Second clip should reference input 3');
    // Check scale/crop/fps are present
    assert.ok(result.filterParts[0].includes(`scale=${W}:${H}`));
    assert.ok(result.filterParts[0].includes(`crop=${W}:${H}`));
    assert.ok(result.filterParts[0].includes('fps=30'));
    assert.ok(result.filterParts[0].includes('tpad=stop_mode=clone'));
  });

  it('applies scene durations to trim and tpad', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }],
      scenes: [{ duration: 5.5 }],
      clipInputStart: 0,
      variant: { transition: 'none', transitionDuration: 0 },
      starts: [0],
    });
    assert.ok(result.filterParts[0].includes('stop_duration=5.5'));
    assert.ok(result.filterParts[0].includes('trim=duration=5.5'));
  });

  it('labels clip outputs as [v0], [v1], etc.', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }, { url: 'b.mp4' }, { url: 'c.mp4' }],
      scenes: [{ duration: 3 }, { duration: 3 }, { duration: 3 }],
      clipInputStart: 0,
      variant: { transition: 'none', transitionDuration: 0 },
      starts: [0, 3, 6],
    });
    assert.ok(result.filterParts[0].includes('[v0]'));
    assert.ok(result.filterParts[1].includes('[v1]'));
    assert.ok(result.filterParts[2].includes('[v2]'));
  });

  it('xfade offsets account for transition duration overlap', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a.mp4' }, { url: 'b.mp4' }, { url: 'c.mp4' }],
      scenes: [{ duration: 3 }, { duration: 4 }, { duration: 3 }],
      clipInputStart: 0,
      variant: { transition: 'xfade:dissolve', transitionDuration: 0.5 },
      starts: [0, 3, 7],
    });
    const xfadeFilters = result.filterParts.filter(f => f.includes('xfade='));
    // First xfade offset: scenes[0].duration - 1*td = 3 - 0.5 = 2.5
    assert.ok(xfadeFilters[0].includes('offset=2.500'));
    // Second xfade offset: scenes[0].duration + scenes[1].duration - 2*td = 3+4-1 = 6
    assert.ok(xfadeFilters[1].includes('offset=6.000'));
  });

  it('xfade uses intermediate labels xf1, xf2... and final label vraw', () => {
    const result = buildVideoFilterChain({
      clips: [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }],
      scenes: [{ duration: 2 }, { duration: 2 }, { duration: 2 }, { duration: 2 }],
      clipInputStart: 0,
      variant: { transition: 'xfade:fade', transitionDuration: 0.3 },
      starts: [0, 2, 4, 6],
    });
    const xfadeFilters = result.filterParts.filter(f => f.includes('xfade='));
    assert.equal(xfadeFilters.length, 3);
    // First two use intermediate labels
    assert.ok(xfadeFilters[0].includes('[xf1]'));
    assert.ok(xfadeFilters[1].includes('[xf2]'));
    // Last one outputs [vraw]
    assert.ok(xfadeFilters[2].includes('[vraw]'));
  });

  it('handles 7 clips (typical 2Step video)', () => {
    const clips = Array(7).fill({ url: 'clip.mp4' });
    const scenes = Array(7).fill({ duration: 4 });
    const starts = [0, 4, 8, 12, 16, 20, 24];
    const result = buildVideoFilterChain({
      clips,
      scenes,
      clipInputStart: 0,
      variant: { transition: 'xfade:fade', transitionDuration: 0.3 },
      starts,
    });
    // 7 scale/crop filters + 6 xfade filters = 13 filter parts
    assert.equal(result.filterParts.length, 13);
    assert.equal(result.videoOutLabel, 'vraw');
  });

  it('offset is clamped to 0 minimum', () => {
    // With very large transition duration and short scenes, offset could go negative
    const result = buildVideoFilterChain({
      clips: [{ url: 'a' }, { url: 'b' }],
      scenes: [{ duration: 0.5 }, { duration: 0.5 }],
      clipInputStart: 0,
      variant: { transition: 'xfade:fade', transitionDuration: 2 },
      starts: [0, 0.5],
    });
    const xfadeFilter = result.filterParts.find(f => f.includes('xfade='));
    assert.ok(xfadeFilter.includes('offset=0.000'), 'Offset should be clamped to 0');
  });
});
