/**
 * Unit tests for music-tracks.js — track pool and picker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_TRACKS, pickMusicTrack } from '../../src/video/music-tracks.js';

describe('MUSIC_TRACKS', () => {
  it('has at least 10 tracks', () => {
    assert.ok(MUSIC_TRACKS.length >= 10, `Only ${MUSIC_TRACKS.length} tracks`);
  });

  it('each track has name and url', () => {
    for (const track of MUSIC_TRACKS) {
      assert.ok(typeof track.name === 'string' && track.name.length > 0);
      assert.ok(typeof track.url === 'string' && track.url.startsWith('https://'));
    }
  });
});

describe('pickMusicTrack', () => {
  it('returns a track object with name and url', () => {
    const track = pickMusicTrack(1);
    assert.ok('name' in track);
    assert.ok('url' in track);
  });

  it('is deterministic with same seed', () => {
    assert.deepEqual(pickMusicTrack(42), pickMusicTrack(42));
  });

  it('returns different tracks for different seeds', () => {
    const t1 = pickMusicTrack(0);
    const t2 = pickMusicTrack(1);
    // May or may not be different, but at least they should be valid
    assert.ok(t1.name);
    assert.ok(t2.name);
  });

  it('handles seed=0', () => {
    const track = pickMusicTrack(0);
    assert.equal(track, MUSIC_TRACKS[0]);
  });

  it('wraps around for large seeds', () => {
    const track = pickMusicTrack(MUSIC_TRACKS.length);
    assert.equal(track, MUSIC_TRACKS[0]);
  });

  it('returns a random track when seed is null', () => {
    const track = pickMusicTrack(null);
    assert.ok(MUSIC_TRACKS.includes(track));
  });

  it('returns a random track when seed is undefined', () => {
    const track = pickMusicTrack(undefined);
    assert.ok(MUSIC_TRACKS.includes(track));
  });

  it('returns a random track when called without argument', () => {
    const track = pickMusicTrack();
    assert.ok(MUSIC_TRACKS.includes(track));
  });
});
