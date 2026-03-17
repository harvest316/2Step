/**
 * Style variants for A/B split testing.
 *
 * Each variant defines:
 *   - font: TTF path (relative to assets/fonts/)
 *   - fontSize: drawtext font size (px)
 *   - textColor: ffmpeg color string
 *   - boxColor: drawtext boxcolor value (ffmpeg color@alpha)
 *   - boxBorderW: padding around text box
 *   - borderW / borderColor: text stroke
 *   - transition: clip-to-clip transition style ('none' | 'fade' | 'xfade:dissolve' | 'xfade:slideleft')
 *   - transitionDuration: seconds for transition overlap (ignored for 'none')
 *
 * Add new variants freely — never remove existing ones (preserve split-test history).
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = resolve(__dirname, '../../assets/fonts');

export const STYLE_VARIANTS = [
  {
    id: 'A',
    // Oswald Bold, white text, dark pill, no transition
    font: `${FONT_DIR}/Oswald-Bold.ttf`,
    fontSize: 76,
    textColor: 'white',
    boxColor: 'black@0.55',
    boxBorderW: 20,
    borderW: 2,
    borderColor: 'black',
    transition: 'none',
    transitionDuration: 0,
  },
  {
    id: 'B',
    // Bebas Neue, gold text, deep navy pill, dissolve transitions
    font: `${FONT_DIR}/BebasNeue-Regular.ttf`,
    fontSize: 88,
    textColor: '0xFFD700',   // gold
    boxColor: '0x001E3C@0.70',
    boxBorderW: 22,
    borderW: 3,
    borderColor: '0x000000',
    transition: 'xfade:dissolve',
    transitionDuration: 0.4,
  },
  {
    id: 'C',
    // Bebas Neue, white text, purple-tinted pill, slide-left transitions
    font: `${FONT_DIR}/BebasNeue-Regular.ttf`,
    fontSize: 96,
    textColor: 'white',
    boxColor: '0x3C0050@0.65',
    boxBorderW: 24,
    borderW: 2,
    borderColor: '0x000000',
    transition: 'xfade:slideleft',
    transitionDuration: 0.35,
  },
  {
    id: 'D',
    // Oswald Bold, cyan-mint text, dark teal pill, fade transitions
    font: `${FONT_DIR}/Oswald-Bold.ttf`,
    fontSize: 76,
    textColor: '0x00FFD1',   // mint/cyan
    boxColor: '0x003333@0.60',
    boxBorderW: 18,
    borderW: 2,
    borderColor: '0x003333',
    transition: 'xfade:fade',
    transitionDuration: 0.3,
  },
];

/**
 * Pick a style variant for a given prospect ID.
 * Deterministic: same ID always returns the same variant.
 * Returns the variant object.
 */
export function pickVariant(prospectId) {
  const idx = ((prospectId - 1) % STYLE_VARIANTS.length + STYLE_VARIANTS.length) % STYLE_VARIANTS.length;
  return STYLE_VARIANTS[idx];
}
