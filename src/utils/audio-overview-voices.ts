import { createHash } from "crypto";
import type { VoiceId } from "@aws-sdk/client-polly";

// AWS Polly Neural-engine English voices only (AUDIO_OVERVIEW_ENGINE — Neural, for its speech
// marks) — same "no Filipino/Tagalog voice, deferred work" constraint
// case-reconstruction-audio.service.ts already documented. Adult voices only: Justin/Ivy/Kevin
// are Neural too, but AWS designates them child voices, an odd fit for two hosts discussing a
// legal analysis. Kendra holds the slot Tiffany had while this pool was Generative (Tiffany has
// no Neural variant) — replaced in place rather than removed, so the pool's length and every
// other index stay the same and no other case's voicePairForCase result changes. Every voice
// here is Neural in both ap-southeast-1 and eu-west-2.
const VOICE_POOL: VoiceId[] = ["Joanna", "Matthew", "Danielle", "Ruth", "Salli", "Stephen", "Kendra"];

// Voices a row saved while the pool was Generative can still carry, mapped to their Neural
// replacement — a re-render of that older script would otherwise fail on every turn.
const RETIRED_VOICES: Record<string, VoiceId> = { Tiffany: "Kendra" };

export function neuralVoiceFor(voiceId: string): string {
  return RETIRED_VOICES[voiceId] ?? voiceId;
}

export interface AudioOverviewVoicePair {
  hostA: VoiceId;
  hostB: VoiceId;
}

/** Deterministically derives a distinct voice pair from the caseId — same two voices every
 * time that case's Audio Overview is (re)generated, per the grilling session's "fixed per
 * case, chosen once" decision, without needing to persist the choice anywhere separately. */
export function voicePairForCase(caseId: string): AudioOverviewVoicePair {
  const hash = createHash("md5").update(caseId).digest();
  const indexA = hash[0] % VOICE_POOL.length;
  // Offset by 1..(length-1) so indexB never lands on indexA, wrapping within the pool.
  const offset = 1 + (hash[1] % (VOICE_POOL.length - 1));
  const indexB = (indexA + offset) % VOICE_POOL.length;
  return { hostA: VOICE_POOL[indexA]!, hostB: VOICE_POOL[indexB]! };
}
