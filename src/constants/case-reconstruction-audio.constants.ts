// Fixed voice for v1 — AWS Polly has no Filipino/Tagalog voice at all, and narrative
// generation has no language parameter yet, so mapping voice to Display Language is
// deferred work rather than a v1 blocker. See docs/adr context in the plan this shipped from.
export const CASE_RECONSTRUCTION_AUDIO_VOICE_ID = "Joanna";

export const CASE_RECONSTRUCTION_AUDIO_OUTPUT_PREFIX = "case-reconstruction-audio/";
