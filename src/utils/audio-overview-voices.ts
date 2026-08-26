import { createHash } from "crypto";
import type { VoiceId } from "@aws-sdk/client-polly";

// AWS Polly neural English voices only — same "no Filipino/Tagalog voice, deferred work"
// constraint case-reconstruction-audio.service.ts already documented. A mix of voices so a
// randomly-picked pair reads as two distinct people, not two similar-sounding ones.
const VOICE_POOL: VoiceId[] = ["Joanna", "Matthew", "Kendra", "Justin", "Ivy", "Kevin"];

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
