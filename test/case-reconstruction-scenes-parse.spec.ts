import { expect } from "chai";
import { describe, it } from "mocha";
import { parseRawScenes, auditScenes } from "../src/utils/case-reconstruction-scenes-parse";

const ONE_SCENE = {
  index: 0,
  time: "14 Nov 2023, ~11:00",
  location: "East span, Brackenmoor Wharf",
  actors: ["Kettleborough", "Delacroix-Hale"],
  action: "Kettleborough resumes lifting operations on the east span.",
  dialogue: [{ actor: "Kettleborough", line: "We're clear to resume." }],
  sourceRefs: [{ docId: "doc-1", page: 12, quote: "resumption of lifting was authorised" }],
  confidence: "high",
  unresolved: [],
};

describe("parseRawScenes", () => {
  it("parses a well-formed [SCENES] block", () => {
    const text = `[SCENES]${JSON.stringify([ONE_SCENE])}[/SCENES]`;
    const scenes = parseRawScenes(text);
    expect(scenes).to.have.length(1);
    expect(scenes![0].time).to.equal(ONE_SCENE.time);
    expect(scenes![0].actors).to.deep.equal(ONE_SCENE.actors);
    expect(scenes![0].dialogue).to.deep.equal(ONE_SCENE.dialogue);
    expect(scenes![0].rawSourceRefs).to.deep.equal(ONE_SCENE.sourceRefs);
  });

  it("returns undefined when the tag is missing", () => {
    expect(parseRawScenes("no tags here")).to.be.undefined;
  });

  it("drops a scene with no action — nothing to render or verify", () => {
    const text = `[SCENES]${JSON.stringify([{ ...ONE_SCENE, action: "" }, ONE_SCENE])}[/SCENES]`;
    const scenes = parseRawScenes(text);
    expect(scenes).to.have.length(1);
  });

  it("defaults an invalid confidence to medium", () => {
    const text = `[SCENES]${JSON.stringify([{ ...ONE_SCENE, confidence: "extremely high" }])}[/SCENES]`;
    expect(parseRawScenes(text)![0].confidence).to.equal("medium");
  });

  it("caps scenes, actors, dialogue, and unresolved lists", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ONE_SCENE, index: i, action: `Scene ${i}` }));
    const text = `[SCENES]${JSON.stringify(many)}[/SCENES]`;
    expect(parseRawScenes(text)!.length).to.be.at.most(20);
  });

  it("handles malformed JSON without throwing", () => {
    expect(parseRawScenes("[SCENES]{not json[/SCENES]")).to.be.undefined;
  });

  it("tolerates a ```json code fence", () => {
    const text = "[SCENES]\n```json\n" + JSON.stringify([ONE_SCENE]) + "\n```\n[/SCENES]";
    expect(parseRawScenes(text)).to.have.length(1);
  });
});

describe("auditScenes", () => {
  it("keeps a sourceRef whose docId resolves and quote appears in the corpus", () => {
    const raw = parseRawScenes(`[SCENES]${JSON.stringify([ONE_SCENE])}[/SCENES]`)!;
    const corpus = new Map([["doc-1", "The record shows the resumption of lifting was authorised by the site engineer."]]);
    const audited = auditScenes(raw, new Set(["doc-1"]), corpus);
    expect(audited[0].sourceRefs).to.have.length(1);
    expect(audited[0].sourceRefs[0]).to.deep.equal({ docId: "doc-1", page: 12, quote: "resumption of lifting was authorised", verified: true });
    expect(audited[0].unresolved).to.deep.equal([]);
  });

  it("drops a sourceRef whose docId doesn't resolve to a real case document", () => {
    const raw = parseRawScenes(`[SCENES]${JSON.stringify([ONE_SCENE])}[/SCENES]`)!;
    const audited = auditScenes(raw, new Set(["some-other-doc"]), new Map());
    expect(audited[0].sourceRefs).to.have.length(0);
    expect(audited[0].unresolved[0]).to.match(/no verified source/i);
  });

  it("drops a sourceRef whose quote doesn't appear in that document's corpus", () => {
    const raw = parseRawScenes(`[SCENES]${JSON.stringify([ONE_SCENE])}[/SCENES]`)!;
    const corpus = new Map([["doc-1", "Completely unrelated text."]]);
    const audited = auditScenes(raw, new Set(["doc-1"]), corpus);
    expect(audited[0].sourceRefs).to.have.length(0);
  });

  it("keeps a sourceRef with no quote as long as the docId resolves", () => {
    const scene = { ...ONE_SCENE, sourceRefs: [{ docId: "doc-1", page: 3 }] };
    const raw = parseRawScenes(`[SCENES]${JSON.stringify([scene])}[/SCENES]`)!;
    const audited = auditScenes(raw, new Set(["doc-1"]), new Map());
    expect(audited[0].sourceRefs).to.have.length(1);
    expect(audited[0].sourceRefs[0].quote).to.be.null;
  });

  it("does not duplicate the unresolved note if the model already flagged it", () => {
    const scene = { ...ONE_SCENE, sourceRefs: [], unresolved: ["No verified source for this — speaker unidentified."] };
    const raw = parseRawScenes(`[SCENES]${JSON.stringify([scene])}[/SCENES]`)!;
    const audited = auditScenes(raw, new Set(["doc-1"]), new Map());
    expect(audited[0].unresolved).to.have.length(1);
  });

  it("preserves an existing unrelated unresolved note alongside the new one", () => {
    const scene = { ...ONE_SCENE, sourceRefs: [], unresolved: ["Speaker on the radio at 11:07 is unidentified."] };
    const raw = parseRawScenes(`[SCENES]${JSON.stringify([scene])}[/SCENES]`)!;
    const audited = auditScenes(raw, new Set(["doc-1"]), new Map());
    expect(audited[0].unresolved).to.have.length(2);
  });
});
