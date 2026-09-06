// Well under Polly's sync ~3000-char cap — a single dialogue turn (per the script prompt's
// "conversational lines, not monologues" instruction) never gets remotely close to this, so
// this is a safety net against a malformed/unusually long turn, not a real limit in practice.
export const MAX_TURN_CHARS = 2900;

// Tiny fixed-concurrency pool — Polly synthesis is I/O-bound, this many turns in flight at once
// is enough to matter for a 20-30 turn script without hammering the account's Polly rate limit
// the way full parallelism would.
export const TURN_SYNTHESIS_CONCURRENCY = 4;

export const AUDIO_OVERVIEW_OUTPUT_PREFIX = "audio-overview/";
