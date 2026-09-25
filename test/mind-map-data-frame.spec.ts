/**
 * Stage 5: the API reading chat-wonder's dedicated `[MINDMAP_DATA]` frame (while still reading the
 * map inside `[STRUCTURED_DATA]`, so old and new chat-wonder builds both work), and sending the
 * case digest (`case_mind_map_context`) on a map request.
 *
 * Chat Wonder is a local `ws` server replaying scripted frames; no DB (see
 * test/mind-map-expand.spec.ts for the pattern).
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

import * as config from "../src/config";
import { streamChatWonderMessage } from "../src/utils/chatWonder";
import { parseMindMapDataPayload, stripStructuredBlocks } from "../src/utils/response-parser";
import CaseMindMapSvc, { CHAT_MIND_MAP_CONTEXT_MAX_CHARS } from "../src/services/case-mind-map.service";
import CaseRepo from "../src/repositories/case.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import DocumentRepo from "../src/repositories/document.repository";

const tree = (label: string) => ({
  id: "root",
  label,
  isRoot: true,
  children: [{ id: "legalBasis", label: "Legal Basis", children: [{ id: "x", label: "Art. 1170", children: [] }] }],
});

const structured = (label: string) => `[STRUCTURED_DATA]${JSON.stringify({ timeline: [{ title: "File", description: "d", status: "pending" }], mindMap: tree(label) })}`;
const dedicated = (label: string) => `[MINDMAP_DATA]${JSON.stringify(tree(label))}`;

describe("[MINDMAP_DATA] frame and case_mind_map_context", () => {
  let server: WebSocketServer;
  let afterEnd: string[];
  let payloads: any[];
  let originalWsUrl: string;

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (raw) => {
        payloads.push(JSON.parse(raw.toString()));
        socket.send("The answer.");
        socket.send("__END__");
        for (const frame of afterEnd) socket.send(frame);
        socket.send("[DONE]");
      });
    });
    const { port } = server.address() as AddressInfo;
    originalWsUrl = config.CHAT_WONDER_WS_URL;
    (config as any).CHAT_WONDER_WS_URL = `ws://127.0.0.1:${port}/chat-stream`;
  });

  after(() => {
    (config as any).CHAT_WONDER_WS_URL = originalWsUrl;
    server.close();
  });

  beforeEach(() => {
    payloads = [];
    afterEnd = [];
  });

  const stream = (opts?: { mindMapContext?: string }) =>
    streamChatWonderMessage("sess-1", "Please generate a visual strategy map", () => {}, undefined, undefined, "case-1", "PH", undefined, undefined, undefined, opts);

  it("reads a map sent in its own frame, normalized", async () => {
    afterEnd = [dedicated("Dedicated")];
    const result = await stream();
    expect(result.mindMap?.label).to.equal("Dedicated");
    expect(result.mindMap?.children[0].children[0].id).to.equal("legalBasis.1");
    expect(result.content).to.equal("The answer.");
  });

  it("prefers the dedicated frame over the map inside [STRUCTURED_DATA], in either order", async () => {
    afterEnd = [structured("From structured"), dedicated("Dedicated")];
    expect((await stream()).mindMap?.label).to.equal("Dedicated");
    afterEnd = [dedicated("Dedicated"), structured("From structured")];
    const result = await stream();
    expect(result.mindMap?.label).to.equal("Dedicated");
    // The timeline still comes from [STRUCTURED_DATA].
    expect(result.timeline).to.have.length(1);
  });

  it("still reads the map from [STRUCTURED_DATA] for a chat-wonder build without the new frame", async () => {
    afterEnd = [structured("From structured")];
    expect((await stream()).mindMap?.label).to.equal("From structured");
  });

  it("falls back to [STRUCTURED_DATA] when the dedicated frame is unreadable", async () => {
    afterEnd = ["[MINDMAP_DATA]not json at all", structured("From structured")];
    expect((await stream()).mindMap?.label).to.equal("From structured");
  });

  it("sends case_mind_map_context only when given", async () => {
    afterEnd = [];
    await stream({ mindMapContext: "Case: Cruz v. Reyes" });
    await stream();
    expect(payloads[0].case_mind_map_context).to.equal("Case: Cruz v. Reyes");
    expect(payloads[1]).to.not.have.property("case_mind_map_context");
  });

  it("parseMindMapDataPayload accepts a bare tree or a {mindMap} wrapper", () => {
    expect(parseMindMapDataPayload(JSON.stringify(tree("Bare")))?.label).to.equal("Bare");
    expect(parseMindMapDataPayload(JSON.stringify({ mindMap: tree("Wrapped") }))?.label).to.equal("Wrapped");
    expect(parseMindMapDataPayload("")).to.equal(undefined);
  });

  it("strips a leaked [MINDMAP_DATA] frame from chat text", () => {
    expect(stripStructuredBlocks(`Answer.\n${dedicated("x")}[DONE]`)).to.equal("Answer.");
  });
});

describe("CaseMindMapSvc.buildChatContext", () => {
  const originals = {
    findPromptHeader: CaseRepo.findPromptHeader,
    findings: CaseFindingRepo.list,
    timeline: CaseTimelineRepo.list,
    procedure: ProceduralDeadlineRepo.listProcedureItems,
    documents: DocumentRepo.listAllByCase,
  };
  let findingCount: number;

  beforeEach(() => {
    findingCount = 1;
    CaseRepo.findPromptHeader = (async () => ({ caseName: "Cruz v. Reyes", actionType: "Collection", jurisdiction: null, ukJurisdiction: null })) as any;
    CaseFindingRepo.list = (async () =>
      Array.from({ length: findingCount }, (_, i) => ({ category: "LEGAL_ISSUE", label: `Default on the note ${i}` }))) as any;
    CaseTimelineRepo.list = (async () => [{ title: "Loan due", occurredOn: new Date("2026-06-01") }, { title: "Demand sent", occurredOn: null }]) as any;
    ProceduralDeadlineRepo.listProcedureItems = (async () => [
      { kind: "STRATEGY", label: "Send a final demand" },
      { kind: "NOTE", label: "internal note" },
    ]) as any;
    DocumentRepo.listAllByCase = (async () => [
      { name: "Promissory note.pdf", ragStatus: "READY" },
      { name: "Still indexing.pdf", ragStatus: "PENDING" },
    ]) as any;
  });

  afterEach(() => {
    CaseRepo.findPromptHeader = originals.findPromptHeader;
    CaseFindingRepo.list = originals.findings;
    CaseTimelineRepo.list = originals.timeline;
    ProceduralDeadlineRepo.listProcedureItems = originals.procedure;
    DocumentRepo.listAllByCase = originals.documents;
  });

  it("summarises the case: header, findings, key dates, strategy and indexed documents", async () => {
    const text = await CaseMindMapSvc.buildChatContext("case-1");
    expect(text).to.contain("Case: Cruz v. Reyes — Collection");
    expect(text).to.contain("- LEGAL_ISSUE: Default on the note 0");
    expect(text).to.contain("- 2026-06-01 — Loan due");
    expect(text).to.contain("- undated — Demand sent");
    expect(text).to.contain("- STRATEGY: Send a final demand");
    expect(text).to.contain("- Promissory note.pdf");
    expect(text).to.not.contain("internal note");
    expect(text).to.not.contain("Still indexing.pdf");
  });

  it(`stays under ${CHAT_MIND_MAP_CONTEXT_MAX_CHARS} characters`, async () => {
    findingCount = 500;
    const text = await CaseMindMapSvc.buildChatContext("case-1");
    expect(text.length).to.be.at.most(CHAT_MIND_MAP_CONTEXT_MAX_CHARS + 2);
    expect(text.endsWith("…")).to.equal(true);
  });
});
