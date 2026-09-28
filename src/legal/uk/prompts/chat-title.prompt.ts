// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/chat-title.prompt.ts for the PH counterpart.
import { SMALL_TALK_TITLE_SENTINEL, TITLE_MAX_CHARS, UNCLEAR_TITLE_SENTINEL } from "../../../constants";
import { buildTitleContextLines, type ChatTitleContext } from "../../shared/chat-title-context";

const TITLE_INPUT_CHARS = 500;

export function buildUKChatTitlePrompt(userMessage: string, context: ChatTitleContext = {}): string {
  return (
    `Create a concise title for a UK legal consultation.\n` +
    `Format: [Legal Area]: [Specific Issue] — for example: "Employment Law: Unfair Dismissal", "Company Law: Director's Duties", "Contract Law: Breach of Warranty", "Criminal Law: Reporting a Theft", "Consumer Law: Faulty Goods Refund", "Administrative Law: Lost Driving Licence", "Family Law: Child Custody Arrangements", "Property Law: Landlord Repair Obligations", "Immigration Law: Visa Renewal"\n` +
    `Legal Area is not limited to those examples — pick whichever named or general area of law best fits (Road Traffic Law, Data Protection Law, Civil Law, etc. are all fine). If you are unsure exactly which area fits best, pick your closest reasonable guess — do NOT use the unclear sentinel just because you're uncertain about the area name; that sentinel is reserved only for input with nothing coherent to title (see below).\n` +
    `Always produce a title if the message names any legal topic, area of law, or legal question — even a broad one, or one about an everyday situation (lost documents, disputes, official processes, being contacted by someone, etc.) that has a legal or administrative angle. If it names an area but no narrow issue (e.g. "tell me about UK law" → "UK Law: General Overview", "explain contract law" → "Contract Law: General Overview", "how are murder cases solved in the UK" → "Criminal Law: Murder Case Procedure"), still produce a title — never fall back to unclear just because the question is broad.\n` +
    `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `If the message itself is vague ("what are these documents?", "summarize this", "can you help?") but attached file names or the assistant's reply are given below, title the consultation from THOSE — e.g. "Document Review: Retail Lease Damages Claim". If the message is a real question with no legal angle at all, title it with "General Question" as the area and the question's actual subject as the issue — e.g. "what kind of man would hang on that long?" -> "General Question: Endurance and Persistence", "what's the capital of France?" -> "General Question: Capital of France".\n` +
    `If the message is ONLY a greeting, pleasantry, thanks or small talk — "hi", "hello", "good morning", "how are you", "thanks", "ok" — and no files are attached, output exactly "${SMALL_TALK_TITLE_SENTINEL}". A greeting is not a question: never title it "General Question" or describe the word itself.\n` +
    `Only output exactly "${UNCLEAR_TITLE_SENTINEL}" when there is nothing coherent to title at all — gibberish or random characters with no attachments and no reply to go on. Never output it for a real question, however vague or non-legal.\n` +
    `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
    buildTitleContextLines(context) +
    `Output only the title, nothing else.`
  );
}
