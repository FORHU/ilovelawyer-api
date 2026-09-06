// Chat Wonder appends this trailing chrome onto every reply regardless of prompt — every
// tag-parsing util in this codebase strips it before looking for its own tagged block, so
// this was previously copy-pasted (in some cases with a couple of extra per-prompt blocks
// stripped too) across 9 different files.
const CORE_NOISE_PATTERNS: Array<[RegExp, string]> = [
  [/__END__$/g, ""],
  [/\[Sources\][\s\S]*$/i, ""],
  [/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, ""],
  [/\[RELATED_CASES\][\s\S]*$/i, ""],
];

/** `extraBlockTags` additionally strips whole `[TAG]...[/TAG]` blocks for prompts that emit
 * more than one tagged section in a single reply (e.g. a STRATEGY prompt that also echoes back
 * CONTRADICTIONS/TIMELINE/MINDMAP) — pass the ones a given caller's prompt is known to emit. */
export function stripChatWonderNoise(text: string, extraBlockTags: string[] = []): string {
  let result = text;
  for (const [pattern, replacement] of CORE_NOISE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  for (const tag of extraBlockTags) {
    result = result.replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, "gi"), "");
  }
  return result.trim();
}
