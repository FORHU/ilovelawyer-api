/** Gibberish/unclear input must not get promoted to a fabricated legal-category title (e.g.
 * "Family Law: Child Custody Arrangements" for a message with no legal content at all). The
 * title prompts (chat-title.prompt.ts, UK and PH) give the model an explicit escape hatch —
 * output UNCLEAR_TITLE_SENTINEL instead of guessing — and ChatSvc.isUnclearTitle is what
 * generateAndSaveTitle checks to leave the consultation untitled rather than saving that
 * sentinel verbatim. This only covers the pure parsing/detection logic; the actual LLM call is
 * exercised via generateAndSaveTitle, not tested here (see message-persistence-durability.spec.ts
 * for this codebase's pattern of monkeypatching around a live network call instead).
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import ChatSvc from "../src/services/chat.service";
import { buildUKChatTitlePrompt } from "../src/legal/uk/prompts/chat-title.prompt";
import { buildPHChatTitlePrompt } from "../src/legal/ph/prompts/chat-title.prompt";
import { LEGAL_TAG, LEGAL_TAG_KR, LEGAL_TAG_UK, SMALL_TALK_TITLE_SENTINEL, UNCLEAR_TITLE_SENTINEL } from "../src/constants";
import { buildKRChatTitlePrompt } from "../src/legal/kr/prompts/chat-title.prompt";
import { getChatTitlePromptBuilder } from "../src/legal/prompt-registry";
import { stripLegalTag, withLegalTag } from "../src/utils/chatWonder";

describe("ChatSvc.isUnclearTitle", () => {
  it("recognizes the exact sentinel", () => {
    expect(ChatSvc.isUnclearTitle(UNCLEAR_TITLE_SENTINEL)).to.be.true;
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(ChatSvc.isUnclearTitle(`  ${UNCLEAR_TITLE_SENTINEL.toLowerCase()}  `)).to.be.true;
  });

  it("does not flag a real, unrelated title", () => {
    expect(ChatSvc.isUnclearTitle("Family Law: Child Custody Arrangements")).to.be.false;
  });

  it("does not flag a title that merely contains the sentinel as a substring", () => {
    expect(ChatSvc.isUnclearTitle(`Contract Law: ${UNCLEAR_TITLE_SENTINEL} Clause`)).to.be.false;
  });
});

describe("ChatSvc.parseTitle + isUnclearTitle, end to end", () => {
  it("a raw sentinel response (possibly quoted, as the LLM might format any title) parses to unclear", () => {
    const raw = `"${UNCLEAR_TITLE_SENTINEL}"\n`;
    expect(ChatSvc.isUnclearTitle(ChatSvc.parseTitle(raw))).to.be.true;
  });

  it("a normal category title still parses through untouched", () => {
    const raw = `"Employment Law: Unfair Dismissal".`;
    const title = ChatSvc.parseTitle(raw);
    expect(ChatSvc.isUnclearTitle(title)).to.be.false;
    expect(title).to.equal("Employment Law: Unfair Dismissal");
  });
});

describe("chat title prompts", () => {
  it("UK prompt instructs the model to use the sentinel instead of guessing", () => {
    const prompt = buildUKChatTitlePrompt("asdkfj alskdjf laksjdf");
    expect(prompt).to.include(UNCLEAR_TITLE_SENTINEL);
    expect(prompt.toLowerCase()).to.include("gibberish");
  });

  it("PH prompt instructs the model to use the sentinel instead of guessing", () => {
    const prompt = buildPHChatTitlePrompt("asdkfj alskdjf laksjdf");
    expect(prompt).to.include(UNCLEAR_TITLE_SENTINEL);
    expect(prompt.toLowerCase()).to.include("gibberish");
  });
});

describe("KR chat", () => {
  it("KR title prompt asks for the colon format, in the user's language, with both sentinels", () => {
    const prompt = buildKRChatTitlePrompt("임대차 보증금을 돌려받지 못했어요");
    expect(prompt).to.include(UNCLEAR_TITLE_SENTINEL);
    expect(prompt).to.include(SMALL_TALK_TITLE_SENTINEL);
    expect(prompt).to.include("South Korean legal consultation");
    expect(prompt).to.include("임대차 보증금을 돌려받지 못했어요");
  });

  it("a Korean title in the colon format is a valid title", () => {
    expect(ChatSvc.isValidTitle(ChatSvc.parseTitle("노동법: 부당해고 구제"))).to.be.true;
    expect(ChatSvc.isValidTitle("부당해고 구제")).to.be.false;
  });

  it("each tenant gets its own chat-title prompt; KR no longer 501s", () => {
    expect(getChatTitlePromptBuilder("KR")).to.equal(buildKRChatTitlePrompt);
    expect(getChatTitlePromptBuilder("UK")).to.equal(buildUKChatTitlePrompt);
    expect(getChatTitlePromptBuilder("PH")).to.equal(buildPHChatTitlePrompt);
  });

  it("sends each tenant's legal tag to Chat Wonder, replacing any tag already on the message", () => {
    expect(withLegalTag("보증금 반환 소송", "KR")).to.equal(`${LEGAL_TAG_KR} 보증금 반환 소송`);
    expect(withLegalTag("unfair dismissal", "UK")).to.equal(`${LEGAL_TAG_UK} unfair dismissal`);
    expect(withLegalTag("estafa", "PH")).to.equal(`${LEGAL_TAG} estafa`);
    expect(withLegalTag("estafa")).to.equal(`${LEGAL_TAG} estafa`);
    expect(withLegalTag(`${LEGAL_TAG} 보증금`, "KR")).to.equal(`${LEGAL_TAG_KR} 보증금`);
    expect(stripLegalTag(`${LEGAL_TAG_KR} 질문`)).to.equal("질문");
  });
});
