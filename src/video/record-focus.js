#!/usr/bin/env node

/**
 * CLI tool for recording focus areas of Kling clips into clips/focus-overrides.json.
 *
 * Focus = where the visual subject is in the portrait frame:
 *   top    → subject in upper portion → text overlay goes to BOTTOM
 *   center → subject in middle        → text overlay goes to TOP (default)
 *   bottom → subject in lower portion → text overlay goes to TOP
 *
 * Usage:
 *   node src/video/record-focus.js                    # interactive mode, walks all clips
 *   node src/video/record-focus.js blocked-drain-hook-a.mp4 top
 *   node src/video/record-focus.js --list             # show current overrides
 *   node src/video/record-focus.js --missing          # list clips with no override recorded
 *
 * The file opened in your media player is the LOCAL clip (clips/...).
 * Focus is saved to clips/focus-overrides.json — picked up by shotstack-lib.js at render time.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import * as readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CLIPS_ROOT = resolve(ROOT, 'clips');
const OVERRIDES_PATH = resolve(ROOT, 'clips/focus-overrides.json');

function loadOverrides() {
  if (!existsSync(OVERRIDES_PATH)) return {};
  const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
}

function saveOverrides(overrides) {
  const out = {
    _comment: 'Maps clip filename (without path) to focus area. Focus values: top | center | bottom.',
    _usage: 'Edit this file after watching clips. pickClipsFromPool() loads it at runtime.',
    _values: {
      top:    'subject in upper frame → text at bottom',
      center: 'subject in middle → text at top (default)',
      bottom: 'subject in lower frame → text at top',
    },
    ...overrides,
  };
  writeFileSync(OVERRIDES_PATH, JSON.stringify(out, null, 2) + '\n');
}

function getAllClipFilenames() {
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mp4') && !entry.name.includes('backup')) {
        results.push(entry.name);
      }
    }
  }
  walk(CLIPS_ROOT);
  return results.sort();
}

function findClipPath(filename) {
  // Walk clips/ to find the full path for a given filename
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name === filename) return full;
    }
    return null;
  }
  return walk(CLIPS_ROOT);
}

function openClip(filename) {
  const fullPath = findClipPath(filename);
  if (!fullPath) { console.log(`  ⚠ File not found locally: ${filename}`); return; }
  try {
    execSync(`xdg-open "${fullPath}"`, { stdio: 'ignore' });
    console.log(`  Opened: ${fullPath}`);
  } catch {
    console.log(`  Could not open — path: ${fullPath}`);
  }
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ─── Commands ──────────────────────────────────────────────────────────────────

function list() {
  const overrides = loadOverrides();
  const entries = Object.entries(overrides);
  if (!entries.length) {
    console.log('No focus overrides recorded yet.');
    console.log('Run: node src/video/record-focus.js   (interactive mode)');
    return;
  }
  console.log(`Focus overrides (${entries.length} clips):\n`);
  for (const [filename, focus] of entries.sort()) {
    const arrow = focus === 'top' ? '↑ text→bottom' : focus === 'bottom' ? '↓ text→top' : '· text→top';
    console.log(`  ${focus.padEnd(7)} ${arrow}  ${filename}`);
  }
}

function missing() {
  const overrides = loadOverrides();
  const all = getAllClipFilenames();
  const missing = all.filter(f => !overrides[f]);
  if (!missing.length) {
    console.log(`All ${all.length} clips have focus recorded.`);
    return;
  }
  console.log(`${missing.length} clips without focus override (default: center):\n`);
  for (const f of missing) console.log(`  ${f}`);
  console.log('\nRun interactive mode to record them:');
  console.log('  node src/video/record-focus.js');
}

async function setOne(filename, focus) {
  const valid = ['top', 'center', 'bottom'];
  if (!valid.includes(focus)) {
    console.error(`Invalid focus "${focus}" — must be one of: top, center, bottom`);
    process.exit(1);
  }
  const overrides = loadOverrides();
  overrides[filename] = focus;
  saveOverrides(overrides);
  console.log(`✓ ${filename} → ${focus}`);
}

async function interactive() {
  const overrides = loadOverrides();
  const all = getAllClipFilenames();
  const todo = all.filter(f => !overrides[f]);

  if (!todo.length) {
    console.log(`All ${all.length} clips already have focus recorded.`);
    console.log('Use --list to see them, or pass a filename + focus to update one.');
    return;
  }

  console.log(`\n${todo.length} clips to review (${all.length - todo.length} already done)`);
  console.log('Commands: t=top  c=center  b=bottom  s=skip  q=quit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const filename of todo) {
    console.log(`\nClip: ${filename}`);
    openClip(filename);

    let answer;
    while (true) {
      answer = (await prompt(rl, '  Focus [t/c/b/s/q]: ')).trim().toLowerCase();
      if (['t', 'c', 'b', 's', 'q'].includes(answer)) break;
      console.log('  Enter t, c, b, s, or q');
    }

    if (answer === 'q') { console.log('Quit.'); break; }
    if (answer === 's') { console.log('  Skipped.'); continue; }

    const focusMap = { t: 'top', c: 'center', b: 'bottom' };
    overrides[filename] = focusMap[answer];
    saveOverrides(overrides);
    console.log(`  Saved: ${filename} → ${focusMap[answer]}`);
  }

  rl.close();
  console.log(`\nDone. ${Object.keys(overrides).length} clips have focus recorded.`);
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--list')) {
  list();
} else if (args.includes('--missing')) {
  missing();
} else if (args.length >= 2 && !args[0].startsWith('--')) {
  // Direct set: record-focus.js filename.mp4 top
  setOne(args[0], args[1]);
} else {
  // Interactive mode
  interactive().catch(e => { console.error(e.message); process.exit(1); });
}
