import { createHash } from "crypto";
import type { VoiceId } from "@aws-sdk/client-polly";

// Same Generative-engine, adult-voice pool as Audio Overview (audio-overview-voices.ts) — see
// that file's comment for why these specific seven. Reused rather than duplicated with a
// different pool so the two features don't drift into different voice qualities.
const VOICE_POOL: VoiceId[] = ["Joanna", "Matthew", "Danielle", "Ruth", "Salli", "Stephen", "Tiffany"];

/** Deterministically assigns one Polly voice per distinct actor name (plus a narrator), stable
 * across regenerations of the same case's table read the same way voicePairForCase is stable
 * for Audio Overview — no separate table needed to remember "who got which voice" between runs.
 * The pool has 7 voices; a case with more than 6 named actors (rare — Brackenmoor's morning
 * needs 4) reuses voices round-robin rather than erroring, since a repeated voice across two
 * minor actors is a much smaller cost than refusing to render the table read at all. */
export function castForCase(caseId: string, actorNames: string[]): Record<string, VoiceId> {
  const distinctActors = [...new Set(actorNames.map((name) => name.trim()).filter(Boolean))].sort();
  const narratorHash = createHash("md5").update(`${caseId}:__NARRATOR__`).digest();
  const narratorIndex = narratorHash[0] % VOICE_POOL.length;
  const narratorVoice = VOICE_POOL[narratorIndex]!;

  const cast: Record<string, VoiceId> = { NARRATOR: narratorVoice };
  const used = new Set<VoiceId>([narratorVoice]);

  for (const actor of distinctActors) {
    const hash = createHash("md5").update(`${caseId}:${actor.toLowerCase()}`).digest();
    let index = hash[0] % VOICE_POOL.length;
    // Walk forward deterministically until an unused voice is found, wrapping once — if every
    // voice is already taken (more than 7 distinct actors), this settles on the actor's own
    // hash-derived voice regardless of collision, which is the round-robin reuse described above.
    for (let attempt = 0; attempt < VOICE_POOL.length && used.has(VOICE_POOL[index]!); attempt++) {
      index = (index + 1) % VOICE_POOL.length;
    }
    const voice = VOICE_POOL[index]!;
    cast[actor] = voice;
    used.add(voice);
  }

  return cast;
}
