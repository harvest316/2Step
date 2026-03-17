/**
 * Local ffmpeg video renderer — replaces the Creatomate API.
 *
 * Takes the same inputs (clips, audio buffers, scenes, logo, music, style variant)
 * and produces an MP4 locally. Zero API cost.
 *
 * Requires: ffmpeg in PATH, fonts in assets/fonts/
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm, readFile, access } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { STYLE_VARIANTS } from './style-variants.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = resolve(__dirname, '../../clips');

// Video dimensions (9:16 vertical)
const W = 1080;
const H = 1920;

// Default variant (variant A — original look)
const DEFAULT_VARIANT = STYLE_VARIANTS[0];

/**
 * Download a URL to a local file. Returns the file path.
 */
async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return destPath;
}

/**
 * Return a local path for a clip URL, downloading it to clips/ if not already cached.
 * clips/ is gitignored — large binaries not tracked in git.
 */
async function localClipPath(url) {
  const filename = url.split('/').pop();
  const localPath = join(CLIPS_DIR, filename);
  try {
    await access(localPath);
    return localPath; // already cached
  } catch {
    // Not cached — download
    process.stdout.write(`\n  Caching clip ${filename}...`);
    await mkdir(CLIPS_DIR, { recursive: true });
    await downloadToFile(url, localPath);
    return localPath;
  }
}

/**
 * Escape text for ffmpeg drawtext filter.
 * Must escape: \ ' : [ ] ;
 */
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\\\\\')  // backslash
    .replace(/'/g, "\u2019")      // smart quote (avoids shell/ffmpeg quoting hell)
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;')
    .replace(/%/g, '%%');
}

/**
 * Word-wrap text to fit within a max character width.
 * Preserves explicit \n line breaks.
 * Tighter limit (22) prevents long subtitle lines from overflowing the 1080px frame.
 */
function wordWrap(text, maxChars = 22) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      if (line && (line + ' ' + word).length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Build the drawtext filter string for a single scene's text overlay.
 */
function buildDrawtext(scene, startTime, endTime, clipFocus, variant) {
  const wrapped = wordWrap(scene.text, 28);
  const escaped = escapeDrawtext(wrapped);

  // Position: text goes to y=8% if focus is 'top', else y=80%
  const isTop = clipFocus === 'top';
  const yExpr = isTop
    ? `y=h*0.08`       // ~154px from top
    : `y=h*0.80-th`;   // ~1536px minus text height → text sits above 80% line

  return `drawtext=` +
    `fontfile='${variant.font}'` +
    `:text='${escaped}'` +
    `:fontsize=${variant.fontSize}` +
    `:fontcolor=${variant.textColor}` +
    `:borderw=${variant.borderW}:bordercolor=${variant.borderColor}` +
    `:box=1:boxcolor=${variant.boxColor}:boxborderw=${variant.boxBorderW}` +
    `:x=(w-tw)/2` +
    `:${yExpr}` +
    `:enable='between(t,${startTime},${endTime})'`;
}

/**
 * Build the clip segment filters.
 * If transition = 'none', returns simple [vi] labels and a concat filter.
 * If transition = 'xfade:*', returns per-clip labels and a chain of xfade filters.
 *
 * Returns { filterParts, videoOutLabel }.
 */
function buildVideoFilterChain({ clips, scenes, clipInputStart, variant, starts }) {
  const filterParts = [];

  // Scale/crop each clip; freeze last frame if clip is shorter than scene duration
  for (let i = 0; i < clips.length; i++) {
    filterParts.push(
      `[${clipInputStart + i}:v]` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},setsar=1,fps=30,` +
      `tpad=stop_mode=clone:stop_duration=${scenes[i].duration},` +
      `trim=duration=${scenes[i].duration},setpts=PTS-STARTPTS` +
      `[v${i}]`
    );
  }

  let videoOutLabel;

  if (variant.transition === 'none' || clips.length === 1) {
    // Simple concat
    const concatInputs = clips.map((_, i) => `[v${i}]`).join('');
    filterParts.push(`${concatInputs}concat=n=${clips.length}:v=1:a=0[vraw]`);
    videoOutLabel = 'vraw';
  } else {
    // xfade chain — each transition overlaps by transitionDuration seconds
    // xfade offset = time at which the transition STARTS = cumulative duration up to clip i - overlap * i
    const td = variant.transitionDuration;
    const xfadeType = variant.transition.replace('xfade:', '');
    let prevLabel = 'v0';
    for (let i = 1; i < clips.length; i++) {
      // Offset: cumulative scene durations before clip i, minus i*td (each xfade trims td from total)
      let offset = 0;
      for (let j = 0; j < i; j++) offset += scenes[j].duration;
      offset -= i * td;
      offset = Math.max(0, offset);
      const nextLabel = i === clips.length - 1 ? 'vraw' : `xf${i}`;
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=${xfadeType}:duration=${td}:offset=${offset.toFixed(3)}[${nextLabel}]`
      );
      prevLabel = nextLabel;
    }
    videoOutLabel = 'vraw';
  }

  return { filterParts, videoOutLabel };
}

/**
 * Render a video locally using ffmpeg.
 *
 * @param {Object} opts
 * @param {Array<{url: string, focus: string}>} opts.clips     - Video clip URLs
 * @param {Buffer[]} opts.audioBufs                             - Voiceover audio buffers (MP3)
 * @param {Array<{text: string, duration: number}>} opts.scenes - Scene metadata
 * @param {Buffer|null} opts.logoBuf                            - Processed logo PNG buffer (with pill)
 * @param {string} opts.musicUrl                                - Background music URL
 * @param {number[]} opts.logoSceneIndices                      - Which scene indices show the logo (e.g. [0, 6])
 * @param {string} opts.outputPath                              - Where to write the final MP4
 * @param {Object} [opts.variant]                               - Style variant from style-variants.js
 * @returns {Promise<{path: string, duration: number}>}
 */
export async function renderVideo({
  clips,
  audioBufs,
  scenes,
  logoBuf,
  musicUrl,
  logoSceneIndices = [],
  outputPath,
  variant = DEFAULT_VARIANT,
}) {
  // Verify font file exists — ffmpeg silently falls back to a system font if missing
  await access(variant.font).catch(() => {
    throw new Error(`Font file not found: ${variant.font}`);
  });

  const tmpDir = resolve(__dirname, '../../tmp/ffmpeg-' + randomUUID().slice(0, 8));
  await mkdir(tmpDir, { recursive: true });

  try {
    // ── Resolve clips from local cache (downloads to clips/ on first use) ──
    process.stdout.write('  Resolving clips...');
    const clipPaths = await Promise.all(clips.map(c => localClipPath(c.url)));
    process.stdout.write(' done\n');

    // Write audio buffers to temp files
    const audioPaths = await Promise.all(
      audioBufs.map((buf, i) => {
        const p = join(tmpDir, `audio${i}.mp3`);
        return writeFile(p, buf).then(() => p);
      })
    );

    // Write logo if present
    let logoPath = null;
    if (logoBuf) {
      logoPath = join(tmpDir, 'logo.png');
      await writeFile(logoPath, logoBuf);
    }

    // Download music
    process.stdout.write('  Downloading music...');
    const musicPath = join(tmpDir, 'music.mp3');
    await downloadToFile(musicUrl, musicPath);
    process.stdout.write(' done\n');

    // ── Compute timing ──
    const starts = [];
    let t = 0;
    for (const s of scenes) { starts.push(t); t += s.duration; }
    const totalDuration = t;

    // ── Build ffmpeg command ──
    const inputArgs = [];
    let inputIdx = 0;

    // Inputs: video clips
    const clipInputStart = inputIdx;
    for (let i = 0; i < clipPaths.length; i++) {
      inputArgs.push('-i', clipPaths[i]);
      inputIdx++;
    }

    // Inputs: audio files
    const audioInputStart = inputIdx;
    for (const ap of audioPaths) {
      inputArgs.push('-i', ap);
      inputIdx++;
    }

    // Input: music
    const musicInputIdx = inputIdx;
    inputArgs.push('-i', musicPath);
    inputIdx++;

    // Input: logo (if present)
    let logoInputIdx = -1;
    if (logoPath) {
      logoInputIdx = inputIdx;
      inputArgs.push('-i', logoPath);
      inputIdx++;
    }

    // ── Video filter chain ──
    const { filterParts, videoOutLabel: rawLabel } = buildVideoFilterChain({
      clips, scenes, clipInputStart, variant, starts,
    });

    // Add text overlays (chained drawtext filters on top of raw/xfaded video)
    let prevLabel = rawLabel;
    for (let i = 0; i < scenes.length; i++) {
      const start = starts[i];
      const end = starts[i] + scenes[i].duration;
      const nextLabel = `vt${i}`;
      const dt = buildDrawtext(scenes[i], start, end, clips[i]?.focus, variant);
      filterParts.push(`[${prevLabel}]${dt}[${nextLabel}]`);
      prevLabel = nextLabel;
    }

    // Add logo overlays (if present)
    if (logoPath && logoSceneIndices.length > 0) {
      const n = logoSceneIndices.length;
      // Scale logo once, then split into n copies (ffmpeg outputs can only be consumed once)
      filterParts.push(
        `[${logoInputIdx}:v]scale=${Math.round(W * 0.9)}:-1,split=${n}` +
        Array.from({ length: n }, (_, i) => `[logo${i}]`).join('')
      );

      for (let li = 0; li < n; li++) {
        const idx = logoSceneIndices[li];
        const start = starts[idx];
        const end = starts[idx] + scenes[idx].duration;
        const isTop = clips[idx]?.focus === 'top';
        // Logo goes opposite text: focus=top → logo at bottom (88%), else logo at top (8%)
        const yExpr = isTop
          ? `y=H*0.88-h/2`
          : `y=H*0.08-h/2`;
        const nextLabel = `vl${li}`;
        filterParts.push(
          `[${prevLabel}][logo${li}]overlay=x=(W-w)/2:${yExpr}:` +
          `enable='between(t,${start},${end})'[${nextLabel}]`
        );
        prevLabel = nextLabel;
      }
    }

    const videoOutLabel = prevLabel;

    // ── Audio filter chain ──

    // Delay each voiceover to its scene start time
    for (let i = 0; i < audioPaths.length; i++) {
      const delayMs = Math.round(starts[i] * 1000);
      filterParts.push(
        `[${audioInputStart + i}:a]adelay=${delayMs}|${delayMs},apad[a${i}]`
      );
    }

    // Mix all voiceovers together
    const amixInputs = audioPaths.map((_, i) => `[a${i}]`).join('');
    filterParts.push(
      `${amixInputs}amix=inputs=${audioPaths.length}:duration=longest:normalize=0[voicemix]`
    );

    // Music: trim to total duration, set volume, fade out
    const fadeStart = Math.max(0, totalDuration - 2);
    filterParts.push(
      `[${musicInputIdx}:a]atrim=duration=${totalDuration},` +
      `volume=0.15,` +
      `afade=t=out:st=${fadeStart}:d=2` +
      `[musicout]`
    );

    // Mix voiceover + music
    filterParts.push(
      `[voicemix][musicout]amix=inputs=2:duration=first:normalize=0[afinal]`
    );

    // ── Assemble full command ──
    const filterComplex = filterParts.join(';\n');

    const ffmpegArgs = [
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', `[${videoOutLabel}]`,
      '-map', '[afinal]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-t', String(totalDuration),
      '-y',
      outputPath,
    ];

    process.stdout.write(`  Rendering with ffmpeg (variant ${variant.id})...`);
    await execFileAsync('ffmpeg', ffmpegArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000,   // 5 min max
    });
    process.stdout.write(' done\n');

    return { path: outputPath, duration: totalDuration };
  } finally {
    // Clean up temp dir
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract a poster frame from a video at a given timestamp using ffmpeg.
 * Returns the frame as a JPEG buffer.
 */
export async function extractPosterFrame(videoPath, timestampSec = 2) {
  const tmpPoster = videoPath.replace(/\.mp4$/, '-poster.jpg');
  await execFileAsync('ffmpeg', [
    '-ss', String(timestampSec),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-y',
    tmpPoster,
  ], { timeout: 30000 });
  const buf = await readFile(tmpPoster);
  await rm(tmpPoster, { force: true }).catch(() => {});
  return buf;
}
