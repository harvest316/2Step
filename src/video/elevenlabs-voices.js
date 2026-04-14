/**
 * Country-appropriate ElevenLabs voice mapping.
 *
 * Each country gets a voice with the matching accent for natural-sounding
 * voiceovers. Voice IDs can be overridden via ELEVENLABS_VOICE_{CC} env vars.
 *
 * Current voice library (from ElevenLabs API):
 *   AU: Charlie (IKne3meq5aSn9XLyUdCD) — Deep, Confident, Energetic, Australian
 *   UK: George (JBFqnCBsd6RMkjVDRZzb) — Warm, Captivating Storyteller, British
 *   US: Roger (CwhRBWXzGAHq8TQ4Fs17) — Laid-Back, Casual, Resonant, American
 *   CA: Roger (same as US — no dedicated Canadian voice)
 *   NZ: Charlie (same as AU — closest match)
 *   IE: George (same as UK — closest match)
 *   ZA: Charlie (same as AU — closest match)
 */

const DEFAULT_VOICES = {
  AU: 'IKne3meq5aSn9XLyUdCD', // Charlie — Australian
  UK: 'JBFqnCBsd6RMkjVDRZzb', // George — British
  US: 'CwhRBWXzGAHq8TQ4Fs17', // Roger — American
  CA: 'CwhRBWXzGAHq8TQ4Fs17', // Roger — American (closest)
  NZ: 'IKne3meq5aSn9XLyUdCD', // Charlie — Australian (closest)
  IE: 'JBFqnCBsd6RMkjVDRZzb', // George — British (closest)
  ZA: 'IKne3meq5aSn9XLyUdCD', // Charlie — Australian (closest)
};

/**
 * Get the ElevenLabs voice ID for a country.
 * Checks ELEVENLABS_VOICE_{CC} env var first, falls back to defaults.
 *
 * @param {string} countryCode - e.g. 'AU', 'UK', 'US'
 * @returns {string} ElevenLabs voice ID
 */
export function getVoiceId(countryCode) {
  if (!countryCode) throw new Error('country_code is required for voice selection');
  const cc = countryCode.toUpperCase();
  const envKey = `ELEVENLABS_VOICE_${cc}`;
  const voiceId = process.env[envKey] || DEFAULT_VOICES[cc];
  if (!voiceId) throw new Error(`No ElevenLabs voice configured for country: ${cc} (set ${envKey} or add to DEFAULT_VOICES)`);
  return voiceId;
}

/**
 * Get all voice IDs (for preloading/validation).
 */
export function getAllVoiceIds() {
  return { ...DEFAULT_VOICES };
}
