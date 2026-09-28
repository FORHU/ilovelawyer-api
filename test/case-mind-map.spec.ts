/**
 * The document-built case mind map (Stage 3): CaseMindMapSvc's build-or-skip rules, and expand/
 * undo on that map through MindMapSvc.
 *
 * Same no-AWS/DB/Redis pattern as test/mind-map-expand.spec.ts: repository/service statics are
 * monkeypatched, and Chat Wonder is a local `ws` server replaying a scripted reply.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

import * as config from "../src/config";
import * as chatWonder from "../src/utils/chatWonder";
import * as excerpts from "../src/utils/case-document-excerpts";
import { redis } from "../src/lib/redis";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import CaseRepo from "../src/repositories/case.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import MindMapRepo, { MindMapVersionConflictError } from "../src/repositories/mind-map.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseAccess from "../src/utils/case-access";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import CaseMindMapSvc, { keepOnlyCaseSources } from "../src/services/case-mind-map.service";
import MindMapSvc from "../src/services/mind-map.service";
import { MindMapItem, normalizeMindMap } from "../src/utils/response-parser";
import { findMindMapNode } from "../src/utils/mind-map-tree";
import { computeReadySetFingerprint } from "../src/utils/ready-set-fingerprint";

const DOC_A = "11111111-1111-1111-1111-111111111111";
const DOC_B = "22222222-2222-2222-2222-222222222222";

const builtTree = {
  id: "root",
  label: "Cruz v. Reyes — unpaid loan",
  isRoot: true,
  children: [
    {
      id: "legalBasis",
      label: "Legal Basis",
      children: [
        {
          label: "Art. 1170 breach",
          description: "The promissory note sets a 1 June due date.",
          sources: [{ documentId: DOC_A, page: 2 }, { documentId: "not-a-case-document", page: 1 }],
          children: [],
        },
      ],
    },
    { id: "keyFacts", label: "Key Facts", children: [{ label: "Loan of PHP 500,000", sources: [{ documentId: DOC_B }], children: [] }] },
    { id: "remedies", label: "Remedies", children: [] },
    { id: "risks", label: "Risks", children: [] },
    { id: "nextSteps", label: "Next Steps", children: [] },
  ],
};

const tagged = (tree: unknown) => `[MINDMAP]${JSON.stringify(tree)}[/MINDMAP]`;

describe("Case mind map (built from documents)", () => {
  let server: WebSocketServer;
  let replyFrames: string[];
  let prompts: string[];
  let originalWsUrl: string;
  const originals: Record<string, any> = {};
  const patch = (target: any, key: string, value: unknown) => {
    const id = `${target.name ?? "module"}.${key}`;
    if (!(id in originals)) originals[id] = { target, key, value: target[key] };
    target[key] = value;
  };

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (raw) => {
        prompts.push(JSON.parse(raw.toString()).user_input);
        for (const frame of replyFrames) socket.send(frame);
        socket.send("__END__");
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

  // In-memory CaseMindMap row + its revisions.
  let map: {
    id: string;
    caseId: string;
    data: unknown;
    version: number;
    readySetFingerprint: string | null;
    documentIds: string[];
    retiredAt: Date | null;
  } | null;
  let syncSaves: MindMapItem[];
  let revisionReasons: string[];
  let documents: { id: string; name: string; ragStatus: string }[];
  let audits: string[];
  let conflictOnNextSave: boolean;

  beforeEach(() => {
    prompts = [];
    audits = [];
    replyFrames = [tagged(builtTree)];
    map = null;
    revisionReasons = [];
    conflictOnNextSave = false;
    documents = [
      { id: DOC_A, name: "Promissory note.pdf", ragStatus: "READY" },
      { id: DOC_B, name: "Demand letter.pdf", ragStatus: "READY" },
    ];

    patch(config, "CASE_MIND_MAP_AUTO", true);
    patch(DocumentRepo, "listAllByCase", async () => documents);
    patch(DocumentRepo, "findManifestByIds", async () => []);
    patch(DocumentChunkRepo, "findFullTextsByDocuments", async () => new Map());
    patch(redis, "markMany", async () => {});
    patch(excerpts, "buildFactExcerptPack", async () => ({ chunkIds: ["c1"], text: `[${DOC_A} p.2]\nDue on 1 June.`, factCount: 1 }));
    patch(CaseAccess, "resolveTenantCode", async () => "PH");
    patch(CaseAccess, "resolveUkJurisdiction", async () => null);
    patch(CaseAccess, "loadAccessibleCase", async () => ({ id: "case1", caseName: "Cruz v. Reyes", actionType: "Collection" }));
    patch(CaseRepo, "findLanguage", async () => ({ language: "en" }));
    patch(CaseFindingRepo, "list", async () => [{ category: "LEGAL_ISSUE", label: "Default on the note" }]);
    patch(CaseTimelineRepo, "list", async () => [{ title: "Loan due", occurredOn: new Date("2026-06-01") }]);
    patch(ProceduralDeadlineRepo, "listProcedureItems", async () => [
      { kind: "STRATEGY", label: "Send a final demand" },
      { kind: "NOTE", label: "ignored" },
    ]);
    patch(AiGenerationLockSvc, "run", async (_s: string, _k: string, fn: () => Promise<unknown>) => fn());
    patch(OrganizationRepo, "writeAudit", async (a: { action: string }) => {
      audits.push(a.action);
      return {};
    });
    patch(chatWonder, "getChatWonderSessionId", async () => "sess-1");
    patch(DocumentChunkSvc, "relevantChunksForCase", async () => ({ caseDocumentIds: [], caseDocumentChunkIds: [] }));

    patch(MindMapRepo, "findCaseMap", async () => (map ? { ...map } : null));
    patch(MindMapRepo, "findCaseMapMeta", async () => (map ? { ...map } : null));
    patch(MindMapRepo, "retireCaseMap", async () => {
      map = { ...map!, retiredAt: new Date() };
      return map;
    });
    syncSaves = [];
    patch(MindMapRepo, "findById", async () => (map ? { ...map } : null));
    patch(MindMapRepo, "caseMapHasUserChanges", async () => {
      const newest = revisionReasons[revisionReasons.length - 1];
      return Boolean(newest && newest !== "auto");
    });
    patch(MindMapRepo, "saveCaseBuild", async (p: any) => {
      if (conflictOnNextSave) {
        conflictOnNextSave = false;
        map = { ...map!, version: map!.version + 1 };
        revisionReasons.push("expand");
        throw new MindMapVersionConflictError();
      }
      if ((map?.version ?? null) !== p.expectedVersion) throw new MindMapVersionConflictError();
      map = {
        id: "cmm1",
        caseId: p.caseId,
        data: p.data,
        version: (map?.version ?? 0) + 1,
        readySetFingerprint: p.readySetFingerprint,
        documentIds: p.documentIds,
        retiredAt: null,
      };
      revisionReasons.push("auto");
      return { id: "cmm1", version: map.version };
    });
    patch(MindMapRepo, "saveNewVersion", async (p: any) => {
      if (p.expectedVersion !== map!.version) throw new MindMapVersionConflictError();
      if (p.reason === "sync") syncSaves.push(p.data);
      map = { ...map!, data: p.data, version: p.expectedVersion + 1 };
      revisionReasons.push(p.reason);
      return { version: map.version };
    });
    patch(MindMapRepo, "revertOneVersion", async (_kind: string, _id: string, expected: number) => {
      revisionReasons.pop();
      map = { ...map!, version: expected - 1 };
      return { version: map.version, data: map.data };
    });
  });

  afterEach(() => {
    for (const { target, key, value } of Object.values(originals)) target[key] = value;
    for (const k of Object.keys(originals)) delete originals[k];
  });

  it("builds the first map from the documents: fixed branches, path ids, only real case documents cited", async () => {
    const result = await CaseMindMapSvc.generateFromDocuments("case1", "u1");

    expect(result.skipped).to.equal(null);
    expect(map!.version).to.equal(1);
    const tree = map!.data as MindMapItem;
    expect(tree.children.map((c) => c.id)).to.deep.equal(["legalBasis", "keyFacts", "remedies", "risks", "nextSteps"]);
    expect(findMindMapNode(tree, "legalBasis.1")!.node.sources).to.deep.equal([{ documentId: DOC_A, page: 2 }]);
    expect(findMindMapNode(tree, "keyFacts.1")!.node.sources).to.deep.equal([{ documentId: DOC_B }]);
    expect(map!.readySetFingerprint).to.equal(computeReadySetFingerprint(documents));
    expect(audits).to.deep.equal(["mindMap.build"]);

    const prompt = prompts[0];
    expect(prompt).to.contain("Promissory note.pdf");
    expect(prompt).to.contain("LEGAL_ISSUE: Default on the note");
    expect(prompt).to.contain("2026-06-01 — Loan due");
    expect(prompt).to.contain("STRATEGY: Send a final demand");
    expect(prompt).to.not.contain("ignored");
    expect(prompt).to.contain("Due on 1 June.");
  });

  it("skips an automatic rebuild when the documents haven't changed", async () => {
    await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    const result = await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    expect(result.skipped).to.equal("unchanged");
    expect(prompts).to.have.length(1);
  });

  it("rebuilds automatically when a document is added", async () => {
    await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    documents.push({ id: "33333333-3333-3333-3333-333333333333", name: "Reply.pdf", ragStatus: "READY" });
    const result = await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    expect(result.skipped).to.equal(null);
    expect(map!.version).to.equal(2);
  });

  it("leaves an expanded map alone on an automatic run, but a manual Regenerate rebuilds it", async () => {
    await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    revisionReasons.push("expand");
    map = { ...map!, version: 2 };
    documents.push({ id: "33333333-3333-3333-3333-333333333333", name: "Reply.pdf", ragStatus: "READY" });

    const auto = await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    expect(auto.skipped).to.equal("userChanges");
    expect(map!.version).to.equal(2);

    const manual = await CaseMindMapSvc.generateFromDocuments("case1", "u1", "manual");
    expect(manual.skipped).to.equal(null);
    expect(map!.version).to.equal(3);
  });

  it("an automatic build yields to an expand that landed mid-build; a manual one saves over it", async () => {
    await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    documents.push({ id: "33333333-3333-3333-3333-333333333333", name: "Reply.pdf", ragStatus: "READY" });

    conflictOnNextSave = true;
    const auto = await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    expect(auto.skipped).to.equal("changedWhileBuilding");

    conflictOnNextSave = true;
    const manual = await CaseMindMapSvc.generateFromDocuments("case1", "u1", "manual");
    expect(manual.skipped).to.equal(null);
    expect(map!.version).to.equal(4);
  });

  it("keeps the previous map when the reply has no usable tree", async () => {
    replyFrames = ["I could not build a map from these files."];
    const result = await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    expect(result.skipped).to.equal("unusableReply");
    expect(map).to.equal(null);
  });

  it("does nothing without READY documents, or when CASE_MIND_MAP_AUTO is off", async () => {
    documents = [{ id: DOC_A, name: "Scan.pdf", ragStatus: "PENDING" }];
    expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1")).skipped).to.equal("noDocuments");

    documents = [{ id: DOC_A, name: "Scan.pdf", ragStatus: "READY" }];
    (config as any).CASE_MIND_MAP_AUTO = false;
    expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1")).skipped).to.equal("disabled");
    // The kill switch is for the automatic run only — Regenerate still works.
    expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1", "manual")).skipped).to.equal(null);
    expect(prompts).to.have.length(1);
  });

  it("hands a fresh build to Jev in the background (Stage 6)", async () => {
    const checked: (Set<string> | undefined)[] = [];
    patch(CaseMindMapSvc, "checkInBackground", (_caseId: string, _userId: string | undefined, onlyIds?: Set<string>) => checked.push(onlyIds));
    await CaseMindMapSvc.generateFromDocuments("case1", "u1");
    expect(checked).to.deep.equal([undefined]);
  });

  describe("keeping the map in step with the case's documents (Stage 7)", () => {
    const DOC_C = "33333333-3333-3333-3333-333333333333";

    it("leaves archived documents out of the build", async () => {
      documents.push({ id: DOC_C, name: "Old draft.pdf", ragStatus: "READY", status: "ARCHIVED" } as any);
      await CaseMindMapSvc.generateFromDocuments("case1", "u1");
      expect(prompts[0]).to.not.contain("Old draft.pdf");
      expect(map!.documentIds).to.deep.equal([DOC_A, DOC_B].sort());
    });

    it("retires the map when its last document goes, and rebuilds it fresh when documents return", async () => {
      await CaseMindMapSvc.generateFromDocuments("case1", "u1");
      const kept = documents;
      documents = kept.map((d) => ({ ...d, status: "ARCHIVED" }) as any);
      expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1")).skipped).to.equal("retired");
      expect(map!.retiredAt).to.not.equal(null);
      expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1")).skipped).to.equal("noDocuments");

      // Even an expanded map is rebuilt once it's retired — the documents it was built from are gone.
      revisionReasons.push("expand");
      documents = kept;
      expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1")).skipped).to.equal(null);
      expect(map!.retiredAt).to.equal(null);
    });

    it('"Refresh analysis" rebuilds even when the documents are unchanged — but not over expansions', async () => {
      await CaseMindMapSvc.generateFromDocuments("case1", "u1");
      expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1", "refresh")).skipped).to.equal(null);
      expect(map!.version).to.equal(2);
      revisionReasons.push("expand");
      expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1", "refresh")).skipped).to.equal("userChanges");
    });

    it("on an expanded map, drops citations to a removed document and marks those points", async () => {
      await CaseMindMapSvc.generateFromDocuments("case1", "u1");
      revisionReasons.push("expand");
      documents = documents.filter((d) => d.id !== DOC_B);

      expect((await CaseMindMapSvc.generateFromDocuments("case1", "u1")).skipped).to.equal("userChanges");
      expect(syncSaves).to.have.length(1);
      const tree = map!.data as MindMapItem;
      expect(findMindMapNode(tree, "keyFacts.1")!.node).to.include({ sourceRemoved: true });
      expect(findMindMapNode(tree, "keyFacts.1")!.node.sources).to.equal(undefined);
      // A point citing only documents that are still there is untouched.
      expect(findMindMapNode(tree, "legalBasis.1")!.node.sourceRemoved).to.equal(undefined);
    });

    it("documentsChangedSinceBuild: true after an archive, false otherwise, and false with no map", async () => {
      expect(await CaseMindMapSvc.documentsChangedSinceBuild("case1")).to.equal(false);
      await CaseMindMapSvc.generateFromDocuments("case1", "u1");
      expect(await CaseMindMapSvc.documentsChangedSinceBuild("case1")).to.equal(false);
      documents = documents.map((d) => (d.id === DOC_B ? ({ ...d, status: "ARCHIVED" } as any) : d));
      expect(await CaseMindMapSvc.documentsChangedSinceBuild("case1")).to.equal(true);
    });
  });

  describe("expand and undo on the case map", () => {
    beforeEach(async () => {
      await CaseMindMapSvc.generateFromDocuments("case1", "u1");
      prompts = [];
      replyFrames = [`[MINDMAP_CHILDREN]${JSON.stringify([{ label: "Note signed 3 March" }])}[/MINDMAP_CHILDREN]`];
    });

    it("asks for sources on the case map, keeps only real case documents, and has Jev check just the new points", async () => {
      const checked: (Set<string> | undefined)[] = [];
      patch(CaseMindMapSvc, "checkInBackground", (_caseId: string, _userId: string | undefined, onlyIds?: Set<string>) => checked.push(onlyIds));
      replyFrames = [
        `[MINDMAP_CHILDREN]${JSON.stringify([{ label: "Note signed 3 March", sources: [{ documentId: DOC_A, page: 1 }, { documentId: "invented-id" }] }])}[/MINDMAP_CHILDREN]`,
      ];
      const result = await MindMapSvc.expandCaseNode({ userId: "u1", caseId: "case1", nodeId: "legalBasis.1" });
      expect(prompts[0]).to.contain("## DOCUMENTS");
      expect(prompts[0]).to.contain(DOC_A);
      expect(findMindMapNode(result.mindMap, "legalBasis.1.1")!.node.sources).to.deep.equal([{ documentId: DOC_A, page: 1 }]);
      expect(checked).to.deep.equal([new Set(["legalBasis.1.1"])]);
    });

    it("expands a node on the case map and returns it as a case change", async () => {
      const result = await MindMapSvc.expandCaseNode({ userId: "u1", caseId: "case1", nodeId: "legalBasis.1" });
      expect(result).to.include({ kind: "case", caseId: "case1", version: 2, expandedNodeId: "legalBasis.1" });
      expect(result.messageId).to.equal(undefined);
      expect(findMindMapNode(result.mindMap, "legalBasis.1.1")!.node.label).to.equal("Note signed 3 March");
      // The node's existing citation survives the re-normalize.
      expect(findMindMapNode(result.mindMap, "legalBasis.1")!.node.sources).to.deep.equal([{ documentId: DOC_A, page: 2 }]);
    });

    it("undoes an expand, but never a build", async () => {
      await MindMapSvc.expandCaseNode({ userId: "u1", caseId: "case1", nodeId: "legalBasis.1" });
      const undone = await MindMapSvc.revertCaseMap({ userId: "u1", caseId: "case1", expectedVersion: 2 });
      expect(undone.version).to.equal(1);

      await MindMapSvc.revertCaseMap({ userId: "u1", caseId: "case1" }).then(
        () => expect.fail("expected a 409"),
        (err) => expect(err.statusCode).to.equal(409),
      );
    });
  });
});

describe("case mind map helpers", () => {
  it("keepOnlyCaseSources drops ids that aren't the case's documents", () => {
    const tree = normalizeMindMap(builtTree)!;
    const dropped = keepOnlyCaseSources(tree, new Set([DOC_A]));
    expect(dropped).to.equal(2);
    expect(findMindMapNode(tree, "legalBasis.1")!.node.sources).to.deep.equal([{ documentId: DOC_A, page: 2 }]);
    expect(findMindMapNode(tree, "keyFacts.1")!.node.sources).to.equal(undefined);
  });

  it("normalizeMindMap keeps well-formed sources and discards malformed ones", () => {
    const tree = normalizeMindMap({
      label: "Case",
      children: [{ label: "x", sources: [{ documentId: " a " , page: "3" }, { page: 2 }, { documentId: "b", page: -1 }, "junk"], children: [] }],
    })!;
    expect(tree.children[0].sources).to.deep.equal([{ documentId: "a", page: 3 }, { documentId: "b" }]);
  });

  it("computeReadySetFingerprint ignores order and non-READY documents", () => {
    const a = computeReadySetFingerprint([{ id: "1", ragStatus: "READY" }, { id: "2", ragStatus: "READY" }, { id: "3", ragStatus: "PENDING" }]);
    const b = computeReadySetFingerprint([{ id: "2", ragStatus: "READY" }, { id: "1", ragStatus: "READY" }]);
    expect(a).to.equal(b);
  });
});
