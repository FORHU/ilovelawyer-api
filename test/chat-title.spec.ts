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
import { UNCLEAR_TITLE_SENTINEL } from "../src/constants";

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
