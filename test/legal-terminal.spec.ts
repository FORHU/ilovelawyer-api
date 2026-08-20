import { expect } from "chai";
import { describe, it } from "mocha";
import { defaultPresetForSku, PANEL_CATALOG, skuAllowsPanel } from "../src/constants/terminal.constants";
import { buildDefaultLayout, normalizeLayout } from "../src/utils/terminal-layout";
import { computePhilippineDeadline, isNonWorkingDay } from "../src/utils/ph-deadline";
import { evaluateCitation } from "../src/utils/citation-validity";
import { extractFacts, findContradictions } from "../src/utils/fact-extract";
import { extractContradictionHits } from "../src/utils/contradiction-scan";
import { buildContradictionPrompt } from "../src/constants/contradiction-scan.constants";
import { extractCaseStrategy } from "../src/utils/case-strategy-parse";
import { buildCaseStrategyPrompt } from "../src/constants/case-strategy.constants";
import { scoreCaseRisks } from "../src/utils/case-risk-score";

describe("Legal Terminal — workspace catalog", () => {
  it("defaults Solo to 2-pane and hides redTeam", () => {
    expect(defaultPresetForSku("SOLO")).to.equal("PANE_2");
    const layout = buildDefaultLayout("PANE_2", "SOLO");
    expect(layout.panels.find((p) => p.id === "command")?.visible).to.equal(true);
    expect(layout.panels.find((p) => p.id === "evidence")?.visible).to.equal(true);
    expect(layout.panels.find((p) => p.id === "redTeam")?.visible).to.equal(false);
  });

  it("does not unlock teamAudit for Solo", () => {
    expect(skuAllowsPanel("SOLO", "PROFESSIONAL")).to.equal(false);
    const layout = buildDefaultLayout("PANE_6", "SOLO");
    expect(layout.panels.find((p) => p.id === "teamAudit")).to.equal(undefined);
  });

  it("forces redTeam hidden even if the client sends visible true", () => {
    const layout = normalizeLayout(
      {
        preset: "PANE_4",
        panels: [{ id: "redTeam", visible: true, order: 0, width: 1, height: 1 }],
      },
      "SOLO",
    );
    expect(layout.panels.find((p) => p.id === "redTeam")?.visible).to.equal(false);
    expect(layout.panels.some((p) => p.visible)).to.equal(true);
  });

  it("lists every catalog panel", () => {
    expect(PANEL_CATALOG.map((p) => p.id)).to.include.members([
      "command",
      "evidence",
      "law",
      "dates",
      "chat",
      "mindMap",
      "procedure",
    ]);
  });

  it("appends mindMap as hidden when an old layout omits it", () => {
    const layout = normalizeLayout(
      {
        preset: "PANE_2",
        panels: [{ id: "command", visible: true, order: 0, width: 1, height: 1 }],
      },
      "SOLO",
    );
    expect(layout.panels.find((p) => p.id === "mindMap")?.visible).to.equal(false);
  });

  it("keeps freeform pane positions when saving a workspace", () => {
    const layout = normalizeLayout(
      {
        preset: "PANE_4",
        panels: [
          { id: "command", visible: true, order: 0, width: 0.4, height: 0.5, x: 0.1, y: 0.2 },
          { id: "evidence", visible: true, order: 1, width: 0.45, height: 0.4, x: 0.5, y: 0.05 },
        ],
      },
      "SOLO",
    );
    const command = layout.panels.find((p) => p.id === "command");
    expect(command?.x).to.equal(0.1);
    expect(command?.y).to.equal(0.2);
    expect(command?.width).to.equal(0.4);
    expect(command?.height).to.equal(0.5);
  });
});

describe("Legal Terminal — PH deadline engine", () => {
  it("excludes the trigger day and includes the last day", () => {
    const result = computePhilippineDeadline("answer_civil", new Date("2026-03-02T00:00:00Z"));
    expect(result.computedDueDate.toISOString().slice(0, 10)).to.equal("2026-03-17");
    expect(result.calculationNotes).to.include("Rule 22");
  });

  it("rolls a Sunday last day to the next working day", () => {
    const result = computePhilippineDeadline("nlrc_appeal", new Date("2026-08-06T00:00:00Z"));
    expect(result.computedDueDate.toISOString().slice(0, 10)).to.equal("2026-08-17");
    expect(result.calculationNotes).to.include("Rolled forward");
  });

  it("treats Christmas as a holiday", () => {
    const check = isNonWorkingDay(new Date("2026-12-25T00:00:00Z"));
    expect(check.skip).to.equal(true);
    expect(check.reason).to.include("Christmas");
  });
});

describe("Legal Terminal — citation validity", () => {
  it("marks a quotation valid when it appears in official text", () => {
    const result = evaluateCitation({
      quotedText: "The accused is presumed innocent until the contrary is proved",
      officialText: "In all criminal prosecutions, the accused is presumed innocent until the contrary is proved.",
    });
    expect(result.status).to.equal("VALID");
  });

  it("marks a quotation invalid when it is absent", () => {
    const result = evaluateCitation({
      quotedText: "Every lawyer is entitled to a win probability of ninety percent",
      officialText: "No person shall be deprived of life, liberty, or property without due process of law.",
    });
    expect(result.status).to.equal("INVALID");
  });

  it("stays unverified without official text", () => {
    const result = evaluateCitation({ quotedText: "Due process of law" });
    expect(result.status).to.equal("UNVERIFIED");
  });
});

describe("Legal Terminal — contradiction scan", () => {
  it("flags mismatched amounts across documents", () => {
    const left = extractFacts("The deposit was PHP 1,000,000 on 2024-01-15.");
    const right = extractFacts("The deposit was PHP 100,000 on 2024-01-15.");
    const hits = findContradictions(
      { documentId: "a", facts: left },
      { documentId: "b", facts: right },
    );
    expect(hits.some((h) => h.kind === "amount_mismatch")).to.equal(true);
  });
});

describe("Legal Terminal — Chat Wonder contradiction parse", () => {
  const docs = [
    { id: "doc-a", name: "complaint.pdf" },
    { id: "doc-b", name: "demand.pdf" },
  ];
  const allowed = new Set(["doc-a", "doc-b"]);

  it("parses a tagged contradictions block", () => {
    const text = `[CONTRADICTIONS]
[
  {
    "kind": "amount_mismatch",
    "factKey": "purchase_price",
    "leftValue": "₱50,000",
    "rightValue": "80000",
    "leftExcerpt": "purchase price of ₱50,000",
    "rightExcerpt": "the price is ₱80,000",
    "leftDocumentId": "doc-a",
    "rightDocumentId": "doc-b",
    "confidence": 0.9
  }
]
[/CONTRADICTIONS]`;
    const hits = extractContradictionHits(text, allowed);
    expect(hits).to.have.length(1);
    expect(hits![0].factKey).to.equal("purchase_price");
    expect(hits![0].leftValue).to.equal("50000");
    expect(hits![0].rightValue).to.equal("80000");
    expect(hits![0].kind).to.equal("amount_mismatch");
  });

  it("keeps contradictions that live in the same bundled document", () => {
    const text = `[CONTRADICTIONS]
[{"kind":"amount_mismatch","factKey":"purchase_price","leftValue":"50000","rightValue":"80000","leftExcerpt":"complaint: 50,000","rightExcerpt":"demand: 80,000","leftDocumentId":"doc-a","rightDocumentId":"doc-a","confidence":0.9}]
[/CONTRADICTIONS]`;
    const hits = extractContradictionHits(text, new Set(["doc-a"]));
    expect(hits).to.have.length(1);
    expect(hits![0].leftDocumentId).to.equal("doc-a");
    expect(hits![0].rightDocumentId).to.equal("doc-a");
  });

  it("returns undefined when the block is missing so callers can fall back", () => {
    expect(extractContradictionHits("No structured facts here.", allowed)).to.equal(undefined);
  });

  it("returns an empty list when the model explicitly finds none", () => {
    const hits = extractContradictionHits("[CONTRADICTIONS][][/CONTRADICTIONS]", allowed);
    expect(hits).to.deep.equal([]);
  });

  it("drops rows whose document ids are not on the case", () => {
    const text = `[CONTRADICTIONS]
[{"kind":"amount_mismatch","factKey":"purchase_price","leftValue":"1","rightValue":"2","leftExcerpt":"a","rightExcerpt":"b","leftDocumentId":"other","rightDocumentId":"doc-b","confidence":0.9}]
[/CONTRADICTIONS]`;
    expect(extractContradictionHits(text, allowed)).to.deep.equal([]);
  });

  it("strips Chat Wonder [Sources] noise and markdown fences", () => {
    const text = `[CONTRADICTIONS]
\`\`\`json
[{"kind":"date_mismatch","factKey":"incident_date","leftValue":"2024-01-15","rightValue":"2024-01-20","leftExcerpt":"15 January 2024","rightExcerpt":"20 January 2024","leftDocumentId":"doc-a","rightDocumentId":"doc-b","confidence":0.8}]
\`\`\`
[/CONTRADICTIONS]
[Sources] ignored`;
    const hits = extractContradictionHits(text, allowed);
    expect(hits).to.have.length(1);
    expect(hits![0].factKey).to.equal("incident_date");
  });

  it("includes ready document ids in the Chat Wonder prompt without sample contradiction values", () => {
    const prompt = buildContradictionPrompt(docs);
    expect(prompt.startsWith("[legal ai]")).to.equal(true);
    expect(prompt).to.include("doc-a");
    expect(prompt).to.include("complaint.pdf");
    expect(prompt).to.include("[CONTRADICTIONS]");
    expect(prompt).to.not.include("50000");
    expect(prompt).to.not.include("80000");
    expect(prompt).to.not.match(/leftValue": "/);
  });
});

describe("Legal Terminal — Chat Wonder case strategy parse", () => {
  it("parses tagged strategy and todo lists", () => {
    const text = `[STRATEGY]
["Demand the higher principal in the affidavit","Subpoena the original promissory note"]
[/STRATEGY]
[TODOS]
["Get certified copies of the demand letters","Calendar the 15-day answer period"]
[/TODOS]`;
    const parsed = extractCaseStrategy(text);
    expect(parsed?.strategy).to.deep.equal([
      "Demand the higher principal in the affidavit",
      "Subpoena the original promissory note",
    ]);
    expect(parsed?.todos).to.deep.equal([
      "Get certified copies of the demand letters",
      "Calendar the 15-day answer period",
    ]);
    expect(parsed?.dates).to.deep.equal([]);
  });

  it("accepts {label} objects and strips Chat Wonder noise", () => {
    const text = `[STRATEGY]
\`\`\`json
[{"label":"File the complaint in Makati"}]
\`\`\`
[/STRATEGY]
[TODOS]
["Serve summons"]
[/TODOS]
[Sources] ignored`;
    const parsed = extractCaseStrategy(text);
    expect(parsed?.strategy).to.deep.equal(["File the complaint in Makati"]);
    expect(parsed?.todos).to.deep.equal(["Serve summons"]);
  });

  it("returns undefined when both blocks are missing so callers can keep existing items", () => {
    expect(extractCaseStrategy("No structured plan here.")).to.equal(undefined);
  });

  it("returns empty lists when the model explicitly finds none", () => {
    expect(extractCaseStrategy("[STRATEGY][][/STRATEGY]\n[TODOS][][/TODOS]")).to.deep.equal({
      strategy: [],
      todos: [],
      dates: [],
    });
  });

  it("dedupes labels and caps list length", () => {
    const todos = Array.from({ length: 15 }, (_, i) => `"Todo ${i + 1}"`);
    const text = `[STRATEGY]["Same","same"][/STRATEGY]
[TODOS][${todos.join(",")}][/TODOS]`;
    const parsed = extractCaseStrategy(text);
    expect(parsed?.strategy).to.deep.equal(["Same"]);
    expect(parsed?.todos).to.have.length(12);
    expect(parsed?.todos[0]).to.equal("Todo 1");
    expect(parsed?.todos[11]).to.equal("Todo 12");
  });

  it("includes ready document ids in the Chat Wonder prompt without sample plan text", () => {
    const prompt = buildCaseStrategyPrompt([{ id: "doc-a", name: "complaint.pdf" }]);
    expect(prompt.startsWith("[legal ai]")).to.equal(true);
    expect(prompt).to.include("doc-a");
    expect(prompt).to.include("complaint.pdf");
    expect(prompt).to.include("[STRATEGY]");
    expect(prompt).to.include("[TODOS]");
    expect(prompt).to.include("[DATES]");
    expect(prompt).to.not.include("promissory note");
    expect(prompt).to.not.include("affidavit");
  });

  it("parses a tagged dates block and drops rows without a real date", () => {
    const text = `[STRATEGY][][/STRATEGY]
[TODOS][][/TODOS]
[DATES]
[
  {"title":"Demand letter sent","date":"2024-03-01"},
  {"title":"No date here"},
  {"title":"Hearing","date":"not-a-date"}
]
[/DATES]`;
    const parsed = extractCaseStrategy(text);
    expect(parsed?.dates).to.deep.equal([{ title: "Demand letter sent", date: "2024-03-01" }]);
  });
});

describe("Legal Terminal — live risk analysis", () => {
  it("stays low when the case has no signals", () => {
    const result = scoreCaseRisks({});
    expect(result.overall.level).to.equal("LOW");
    expect(result.overall.score).to.equal(0);
    expect(result.liability.level).to.equal("LOW");
  });

  it("raises overall risk for contradictions and overdue deadlines", () => {
    const result = scoreCaseRisks({
      now: new Date("2026-08-20T00:00:00Z"),
      contradictions: [{ kind: "date_mismatch" }, { kind: "party_mismatch" }],
      deadlines: [{ computedDueDate: "2026-08-01T00:00:00Z" }],
    });
    expect(result.overall.score).to.be.greaterThan(30);
    expect(result.overall.level).to.equal("MEDIUM");
    expect(result.overall.drivers.map((d) => d.code)).to.include("contradictions");
  });

  it("raises liability risk for amount mismatches more than overall tagging", () => {
    const result = scoreCaseRisks({
      contradictions: [{ kind: "amount_mismatch" }],
    });
    expect(result.liability.score).to.be.greaterThan(result.overall.score);
    expect(result.liability.drivers[0].code).to.equal("amountMismatches");
  });

  it("treats a fatal issue as high overall risk", () => {
    const result = scoreCaseRisks({
      risks: [{ severity: "FATAL", status: "OPEN" }],
    });
    expect(result.overall.level).to.equal("HIGH");
  });

  it("ignores accepted risks", () => {
    const result = scoreCaseRisks({
      risks: [{ severity: "FATAL", status: "ACCEPTED" }],
    });
    expect(result.overall.score).to.equal(0);
  });
});
