import { stripChatWonderNoise } from "./chat-wonder-noise";

// Per-register cap — each of the three narratives gets its own budget rather than sharing one,
// since the prompt now asks for three separate stories in one response instead of one.
const MAX_NARRATIVE_CHARS = 12000;

export function cleanRegister(text: string): string {
  return stripChatWonderNoise(text).slice(0, MAX_NARRATIVE_CHARS);
}
