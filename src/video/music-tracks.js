/**
 * Royalty-free background music tracks for video generation.
 * All from Mixkit (mixkit.co/license/) — free for commercial use, no attribution required.
 * All tracks are 3+ minutes — well above the 30s video length, no loop seam issues.
 *
 * Pick randomly per render via pickMusicTrack().
 */

export const MUSIC_TRACKS = [
  { name: 'I Believe in Us',   url: 'https://assets.mixkit.co/music/1030/1030.mp3' },
  { name: 'Dreaming of You',   url: 'https://assets.mixkit.co/music/952/952.mp3' },
  { name: 'Mountains',         url: 'https://assets.mixkit.co/music/187/187.mp3' },
  { name: 'What About Action', url: 'https://assets.mixkit.co/music/474/474.mp3' },
  { name: 'Pop One',           url: 'https://assets.mixkit.co/music/664/664.mp3' },
  { name: 'Talent in the Air', url: 'https://assets.mixkit.co/music/473/473.mp3' },
  { name: 'Uplifting Bass',    url: 'https://assets.mixkit.co/music/726/726.mp3' },
  { name: 'Focus on Yourself', url: 'https://assets.mixkit.co/music/568/568.mp3' },
  { name: 'Close Up',          url: 'https://assets.mixkit.co/music/1167/1167.mp3' },
  { name: 'Rising Forest',     url: 'https://assets.mixkit.co/music/471/471.mp3' },
  { name: 'Pop Track 03',      url: 'https://assets.mixkit.co/music/729/729.mp3' },
  { name: 'Gear',              url: 'https://assets.mixkit.co/music/180/180.mp3' },
];

/**
 * Pick a random music track, optionally seeded by prospect ID for consistency.
 * @param {number} [seed] — prospect ID for deterministic selection
 * @returns {{ name: string, url: string }}
 */
export function pickMusicTrack(seed) {
  const idx = seed != null
    ? seed % MUSIC_TRACKS.length
    : Math.floor(Math.random() * MUSIC_TRACKS.length);
  return MUSIC_TRACKS[idx];
}
