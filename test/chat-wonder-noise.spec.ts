import { expect } from "chai";
import { describe, it } from "mocha";
import { stripChatWonderNoise } from "../src/utils/chat-wonder-noise";

describe("stripChatWonderNoise", () => {
  it("strips a trailing __END__ marker", () => {
    expect(stripChatWonderNoise("some text__END__")).to.equal("some text");
  });

  it("strips a trailing [Sources] block", () => {
    expect(stripChatWonderNoise("some text\n[Sources]\n- a source")).to.equal("some text");
  });

  it("strips a [RELATED_QUERIES] block from the middle of the text", () => {
    expect(stripChatWonderNoise("before[RELATED_QUERIES]junk[/RELATED_QUERIES]after")).to.equal("beforeafter");
  });

  it("strips a trailing [RELATED_CASES] block", () => {
    expect(stripChatWonderNoise("some text\n[RELATED_CASES]\n- a case")).to.equal("some text");
  });

  it("leaves clean text untouched (aside from trimming)", () => {
    expect(stripChatWonderNoise("  clean text  ")).to.equal("clean text");
  });

  it("does not strip an extra block tag unless requested", () => {
    const text = "before[TIMELINE]stuff[/TIMELINE]after";
    expect(stripChatWonderNoise(text)).to.equal(text);
  });

  it("strips requested extra block tags", () => {
    const text = "before[CONTRADICTIONS]a[/CONTRADICTIONS][TIMELINE]b[/TIMELINE][MINDMAP]c[/MINDMAP]after";
    expect(stripChatWonderNoise(text, ["CONTRADICTIONS", "TIMELINE", "MINDMAP"])).to.equal("beforeafter");
  });
});
