/**
 * eSpeak-NG phoneme notation → CMU ARPAbet converter.
 *
 * eSpeak's convert_to_phonemes() returns Kirshenbaum-style phoneme strings
 * like "w_'U_l_A:_r_@" (Woollahra). This module maps them to CMU ARPAbet.
 *
 * Reference: https://github.com/espeak-ng/espeak-ng/blob/master/docs/phonemes.md
 */

// eSpeak phoneme → CMU ARPAbet mapping (longest match first)
const ESPEAK_TO_CMU = [
  // Diphthongs (must come before single vowels)
  ['aI', 'AY'],
  ['aU', 'AW'],
  ['eI', 'EY'],
  ['oI', 'OY'],
  ['oU', 'OW'],
  ['@U', 'OW'],  // GOAT in RP
  ['e@', 'EH'],  // SQUARE vowel
  ['i@', 'IH'],  // NEAR vowel
  ['u@', 'UH'],  // CURE vowel

  // Long vowels
  ['A:', 'AA'],
  ['i:', 'IY'],
  ['u:', 'UW'],
  ['o:', 'AO'],
  ['O:', 'AO'],
  ['3:', 'ER'],   // NURSE (long)
  ['a:', 'AA'],

  // Short vowels
  ['a#', 'AE'],   // Short open-a (eSpeak uses a# for some dialects)
  ['@', 'AH'],    // schwa
  ['3', 'ER'],    // NURSE (short)
  ['a', 'AE'],
  ['A', 'AA'],
  ['E', 'EH'],
  ['I', 'IH'],
  ['i', 'IY'],
  ['O', 'AA'],    // LOT (British RP)
  ['Q', 'AA'],    // LOT variant
  ['U', 'UH'],
  ['u', 'UW'],
  ['V', 'AH'],    // STRUT

  // Consonants
  ['tS', 'CH'],
  ['dZ', 'JH'],
  ['S', 'SH'],
  ['Z', 'ZH'],
  ['T', 'TH'],
  ['D', 'DH'],
  ['N', 'NG'],
  ['h', 'HH'],
  ['j', 'Y'],
  ['b', 'B'],
  ['d', 'D'],
  ['f', 'F'],
  ['g', 'G'],
  ['k', 'K'],
  ['l', 'L'],
  ['m', 'M'],
  ['n', 'N'],
  ['p', 'P'],
  ['r', 'R'],
  ['s', 'S'],
  ['t', 'T'],
  ['v', 'V'],
  ['w', 'W'],
  ['z', 'Z'],
];

const CMU_VOWELS = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
]);

/**
 * Convert eSpeak phoneme string to CMU ARPAbet.
 *
 * @param {string} espeak - eSpeak phoneme string, e.g. "w_'U_l_A:_r_@"
 * @returns {string} CMU ARPAbet, e.g. "W UH1 L AA1 R AH0"
 */
export function espeakToCmu(espeak) {
  // Split on underscore (eSpeak's phoneme separator)
  const tokens = espeak.split('_').filter(Boolean);

  const phonemes = [];
  let nextStress = 0;

  for (const token of tokens) {
    let pos = 0;
    let tok = token;

    // Check for stress markers at start
    if (tok.startsWith("'")) {
      nextStress = 1;
      tok = tok.slice(1);
    } else if (tok.startsWith(',')) {
      nextStress = 2;
      tok = tok.slice(1);
    }

    if (!tok) continue;

    // Match eSpeak phoneme (longest first)
    let matched = false;
    for (const [esp, cmu] of ESPEAK_TO_CMU) {
      if (tok === esp) {
        if (CMU_VOWELS.has(cmu)) {
          phonemes.push(`${cmu}${nextStress}`);
          nextStress = 0;
        } else {
          phonemes.push(cmu);
        }
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Try prefix matching for multi-char tokens (e.g. "e@" in "e@r")
      pos = 0;
      while (pos < tok.length) {
        let found = false;
        for (const [esp, cmu] of ESPEAK_TO_CMU) {
          if (tok.startsWith(esp, pos)) {
            if (CMU_VOWELS.has(cmu)) {
              phonemes.push(`${cmu}${nextStress}`);
              nextStress = 0;
            } else {
              phonemes.push(cmu);
            }
            pos += esp.length;
            found = true;
            break;
          }
        }
        if (!found) {
          pos++; // skip unknown
        }
      }
    }
  }

  return phonemes.join(' ');
}
