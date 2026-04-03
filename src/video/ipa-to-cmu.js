/**
 * IPA → CMU ARPAbet converter for English place names.
 *
 * Maps IPA phonemes (as found in Wikipedia/Wiktionary) to CMU ARPAbet symbols
 * with stress markers. Handles both British and American IPA conventions.
 *
 * Reference: https://en.wikipedia.org/wiki/ARPABET
 *
 * Usage:
 *   import { ipaToCmu } from './ipa-to-cmu.js';
 *   ipaToCmu('wʊˈlɑːrə')  // → 'W UH0 L AA1 R AH0'
 */

// Ordered longest-first so multi-char IPA symbols match before single-char
const IPA_TO_CMU = [
  // Diphthongs (must come before monophthongs)
  ['aɪ', 'AY'],
  ['aʊ', 'AW'],
  ['eɪ', 'EY'],
  ['oʊ', 'OW'],
  ['ɔɪ', 'OY'],
  ['ɛə', 'EH'],  // SQUARE vowel (care, cairns) — monophthong in many dialects
  ['ɪə', 'IH'],  // NEAR vowel (beer, near)
  ['ʊə', 'UH'],  // CURE vowel (tour, cure)

  // Affricates (must come before stops/fricatives)
  ['tʃ', 'CH'],
  ['dʒ', 'JH'],

  // Vowels — long variants first
  ['ɑː', 'AA'],
  ['ɔː', 'AO'],
  ['ɜː', 'ER'],
  ['iː', 'IY'],
  ['uː', 'UW'],
  ['ɛː', 'EH'],  // rare, treat as EH

  // Vowels — short
  ['æ',  'AE'],
  ['ɑ',  'AA'],
  ['ʌ',  'AH'],
  ['ɒ',  'AA'],  // British LOT vowel → AA (closest CMU)
  ['ɔ',  'AO'],
  ['ə',  'AH'],  // schwa → AH (stress 0 applied later)
  ['ᵻ',  'AH'],  // Wikipedia "free vowel" (varies by dialect) → schwa
  ['ɛ',  'EH'],
  ['ɜ',  'ER'],
  ['ɪ',  'IH'],
  ['ʊ',  'UH'],
  ['i',  'IY'],  // final unstressed /i/ → IY
  ['u',  'UW'],
  ['e',  'EH'],  // monophthong /e/
  ['o',  'OW'],  // monophthong /o/
  ['a',  'AE'],  // open front /a/ → AE

  // Consonants
  ['ʃ',  'SH'],
  ['ʒ',  'ZH'],
  ['θ',  'TH'],
  ['ð',  'DH'],
  ['ŋ',  'NG'],
  ['ɡ',  'G'],   // IPA ɡ (U+0261)
  ['ɹ',  'R'],   // IPA alveolar approximant
  ['ɾ',  'R'],   // IPA flap (intervocalic in AU/US)
  ['ʔ',  ''],    // glottal stop — omit (CMU has no equivalent)
  ['ɫ',  'L'],   // dark L
  ['ç',  'HH'],  // voiceless palatal → HH (approximation)
  ['j',  'Y'],
  ['b',  'B'],
  ['d',  'D'],
  ['f',  'F'],
  ['g',  'G'],   // ASCII g
  ['h',  'HH'],
  ['k',  'K'],
  ['l',  'L'],
  ['m',  'M'],
  ['n',  'N'],
  ['p',  'P'],
  ['r',  'R'],
  ['s',  'S'],
  ['t',  'T'],
  ['v',  'V'],
  ['w',  'W'],
  ['z',  'Z'],
];

// Vowel phonemes that get stress markers
const CMU_VOWELS = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
]);

/**
 * Convert IPA string to CMU ARPAbet with stress markers.
 *
 * @param {string} ipa - IPA string, e.g. 'wʊˈlɑːrə' or '/wʊˈlɑːrə/'
 * @returns {string} CMU ARPAbet, e.g. 'W UH0 L AA1 R AH0'
 */
export function ipaToCmu(ipa) {
  // Strip slashes, brackets, whitespace
  let input = ipa.replace(/[\/\[\]\s]/g, '');

  // Parse stress markers and phonemes
  const phonemes = [];
  let nextStress = 0; // 0 = unstressed, 1 = primary, 2 = secondary

  let pos = 0;
  while (pos < input.length) {
    const ch = input[pos];

    // Stress markers
    if (ch === 'ˈ' || ch === '\u02C8') { nextStress = 1; pos++; continue; }
    if (ch === 'ˌ' || ch === '\u02CC') { nextStress = 2; pos++; continue; }

    // Length mark — already handled by long vowel pairs above
    if (ch === 'ː') { pos++; continue; }

    // Syllable boundary — skip
    if (ch === '.' || ch === '‿') { pos++; continue; }

    // Try matching IPA sequences (longest first)
    let matched = false;
    for (const [ipaSeq, cmu] of IPA_TO_CMU) {
      if (input.startsWith(ipaSeq, pos)) {
        if (cmu) { // skip empty (glottal stop)
          if (CMU_VOWELS.has(cmu)) {
            phonemes.push(`${cmu}${nextStress}`);
            nextStress = 0; // reset after applying
          } else {
            phonemes.push(cmu);
          }
        }
        pos += ipaSeq.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Unknown character — skip with warning
      if (ch !== '\'' && ch !== '"') {
        // console.warn(`ipa-to-cmu: unknown IPA character '${ch}' (U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}) in "${ipa}"`);
      }
      pos++;
    }
  }

  return phonemes.join(' ');
}

/**
 * Parse IPA from Wikipedia {{IPAc-en|...}} template format.
 * e.g. "w|ʊ|'|l|ɑː|r|ə" → "wʊˈlɑːrə"
 *
 * @param {string} template - pipe-separated IPA components
 * @returns {string} combined IPA string
 */
// ─── Reverse mapping: CMU → IPA ─────────────────────────────────────────────

const CMU_TO_IPA = {
  // Vowels
  'AA': 'ɑː', 'AE': 'æ', 'AH': 'ə', 'AO': 'ɔː', 'AW': 'aʊ', 'AY': 'aɪ',
  'EH': 'ɛ', 'ER': 'ɜː', 'EY': 'eɪ', 'IH': 'ɪ', 'IY': 'iː',
  'OW': 'oʊ', 'OY': 'ɔɪ', 'UH': 'ʊ', 'UW': 'uː',
  // Consonants
  'B': 'b', 'CH': 'tʃ', 'D': 'd', 'DH': 'ð', 'F': 'f', 'G': 'ɡ',
  'HH': 'h', 'JH': 'dʒ', 'K': 'k', 'L': 'l', 'M': 'm', 'N': 'n',
  'NG': 'ŋ', 'P': 'p', 'R': 'r', 'S': 's', 'SH': 'ʃ', 'T': 't',
  'TH': 'θ', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ',
};

/**
 * Convert CMU ARPAbet to IPA (approximate — for display/researcher prompts).
 *
 * @param {string} cmu - e.g. "W UH1 L AA1 R AH0"
 * @returns {string} IPA, e.g. "wˈʊlˈɑːrə"
 */
export function cmuToIpa(cmu) {
  if (!cmu) return '';
  const tokens = cmu.trim().split(/\s+/);
  let ipa = '';
  for (const token of tokens) {
    const stressMatch = token.match(/^([A-Z]+)([012])$/);
    if (stressMatch) {
      const [, phone, stress] = stressMatch;
      const ipaPhone = CMU_TO_IPA[phone] || phone.toLowerCase();
      if (stress === '1') ipa += 'ˈ' + ipaPhone;
      else if (stress === '2') ipa += 'ˌ' + ipaPhone;
      else ipa += ipaPhone;
    } else {
      ipa += CMU_TO_IPA[token] || token.toLowerCase();
    }
  }
  return ipa;
}

export function parseWikipediaIPA(template) {
  return template
    .split('|')
    .map(part => {
      if (part === "'") return 'ˈ';  // primary stress
      if (part === ',') return 'ˌ';  // secondary stress
      return part;
    })
    .join('');
}
