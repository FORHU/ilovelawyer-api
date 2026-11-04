/** Strips the chat persona's markdown down to plain spoken text, for Polly. The live chat
 * prompts are written assuming a markdown-rendering UI (same as chat-wonder's
 * _generate_audio_overview_script explicitly asks for plain spoken language instead) — rather
 * than touch those prompts, a voice reply's already-generated text is cleaned up here instead. */
export function toSpeechPlainText(markdown: string): string {
  return markdown
    // fenced code blocks first, so their contents don't get mangled by the rules below
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    // images, then links — keep the link text, drop the markup and URL
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // headings, blockquotes, horizontal rules
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*([-*_]){3,}\s*$/gm, "")
    // bullet/numbered list markers — keep the item text
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    // emphasis markers
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    // collapse the blank lines the replacements above tend to leave behind
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
