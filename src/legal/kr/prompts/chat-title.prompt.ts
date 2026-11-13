// LEGAL_REVIEW_REQUIRED: see ../../uk/prompts/chat-title.prompt.ts for the UK counterpart.
import { SMALL_TALK_TITLE_SENTINEL, TITLE_MAX_CHARS, UNCLEAR_TITLE_SENTINEL } from "../../../constants";
import { buildTitleContextLines, type ChatTitleContext } from "../../shared/chat-title-context";

const TITLE_INPUT_CHARS = 500;

/** The title of a KR consultation: the same "[Legal Area]: [Specific Issue]" shape as UK and PH
 * (ChatSvc.isValidTitle needs the ASCII colon), in the language the lawyer wrote in, so a Korean
 * question gets a Korean title. */
export function buildKRChatTitlePrompt(userMessage: string, context: ChatTitleContext = {}): string {
  return (
    `Create a concise title for a South Korean legal consultation.\n` +
    `Format: [Legal Area]: [Specific Issue], always with an ASCII colon ":".\n` +
    `Write the title in the language of the user's message: Korean for a Korean message, English for an English one.\n` +
    `Korean examples: "노동법: 부당해고 구제", "민법: 임대차 보증금 반환", "형법: 사기죄 고소", "가사법: 이혼 시 재산분할", "상법: 이사의 책임", "행정법: 영업정지 처분 취소", "지식재산권법: 상표권 침해", "조세법: 상속세 신고".\n` +
    `English examples: "Labour Law: Unfair Dismissal Remedies", "Civil Law: Lease Deposit Recovery", "Criminal Law: Fraud Complaint", "Family Law: Property Division on Divorce".\n` +
    `Legal Area is not limited to those examples — pick whichever named or general area of Korean law best fits. If you are unsure exactly which area fits best, pick your closest reasonable guess — do NOT use the unclear sentinel just because you're uncertain about the area name; that sentinel is reserved only for input with nothing coherent to title (see below).\n` +
    `Always produce a title if the message names any legal topic, area of law, or legal question — even a broad one, or one about an everyday situation (a lease deposit, a dispute, an official process, being contacted by someone, etc.) that has a legal or administrative angle. If it names an area but no narrow issue (e.g. "한국 법에 대해 알려줘" → "한국 법: 개요", "explain contract law" → "Contract Law: General Overview"), still produce a title — never fall back to unclear just because the question is broad.\n` +
    `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `If the message itself is vague ("이 문서들은 뭐야?", "summarize this", "can you help?") but attached file names or the assistant's reply are given below, title the consultation from THOSE — e.g. "문서 검토: 상가 임대차 손해배상 청구". If the message is a real question with no legal angle at all, title it with "일반 질문" (or "General Question" in English) as the area and the question's actual subject as the issue — e.g. "프랑스의 수도는?" -> "일반 질문: 프랑스의 수도".\n` +
    `If the message is ONLY a greeting, pleasantry, thanks or small talk — "안녕하세요", "감사합니다", "hi", "thanks", "ok" — and no files are attached, output exactly "${SMALL_TALK_TITLE_SENTINEL}". A greeting is not a question: never title it "일반 질문" or describe the word itself.\n` +
    `Only output exactly "${UNCLEAR_TITLE_SENTINEL}" when there is nothing coherent to title at all — gibberish or random characters with no attachments and no reply to go on. Never output it for a real question, however vague or non-legal.\n` +
    `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
    buildTitleContextLines(context) +
    `Output only the title, nothing else.`
  );
}
