// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/chat-title.prompt.ts for the PH counterpart.
import { TITLE_MAX_CHARS, UNCLEAR_TITLE_SENTINEL } from "../../../constants";

const TITLE_INPUT_CHARS = 500;

export function buildUKChatTitlePrompt(userMessage: string): string {
  return (
    `Create a concise title for a UK legal consultation.\n` +
    `Format: [Legal Area]: [Specific Issue] — for example: "Employment Law: Unfair Dismissal", "Company Law: Director's Duties", "Contract Law: Breach of Warranty", "Criminal Law: Reporting a Theft", "Consumer Law: Faulty Goods Refund", "Administrative Law: Lost Driving Licence", "Family Law: Child Custody Arrangements", "Property Law: Landlord Repair Obligations", "Immigration Law: Visa Renewal"\n` +
    `Legal Area is not limited to those examples — pick whichever named or general area of law best fits (Road Traffic Law, Data Protection Law, Civil Law, etc. are all fine). If you are unsure exactly which area fits best, pick your closest reasonable guess — do NOT use the unclear sentinel just because you're uncertain about the area name; that sentinel is reserved only for messages with no legal topic at all (see below).\n` +
    `Always produce a title if the message names any legal topic, area of law, or legal question — even a broad one, or one about an everyday situation (lost documents, disputes, official processes, being contacted by someone, etc.) that has a legal or administrative angle. If it names an area but no narrow issue (e.g. "tell me about UK law" → "UK Law: General Overview", "explain contract law" → "Contract Law: General Overview", "how are murder cases solved in the UK" → "Criminal Law: Murder Case Procedure"), still produce a title — never fall back to unclear just because the question is broad.\n` +
    `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `Only output exactly "${UNCLEAR_TITLE_SENTINEL}" — never guess — when the message contains no identifiable legal or administrative topic at all (e.g. gibberish, random characters, or small talk unrelated to law, like "how's the weather").\n` +
    `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
    `Output only the title, nothing else.`
  );
}
