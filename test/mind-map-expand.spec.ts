/**
 * "Expand with AI" end to end, API side: MindMapSvc.expandNode / revert and the
 * resolveOnAnswerEnd option on streamChatWonderMessage they rely on.
 *
 * Same no-AWS/DB/Redis pattern as test/chat-cancel-generation.spec.ts: repository/service statics
 * are monkeypatched, and Chat Wonder is a local `ws` server replaying a scripted reply.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

import * as config from "../src/config";
import * as chatWonder from "../src/utils/chatWonder";
import ChatRepo from "../src/repositories/chat.repository";
import MindMapRepo, { MindMapVersionConflictError } from "../src/repositories/mind-map.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseAccess from "../src/utils/case-access";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import MindMapSvc from "../src/services/mind-map.service";
import { MindMapItem, normalizeMindMap } from "../src/utils/response-parser";
import { findMindMapNode } from "../src/utils/mind-map-tree";
import { editMindMapNodeSchema } from "../src/validation/chat.validation";

const legacyMap = {
  id: "r",
  label: "Unpaid loan",
  isRoot: true,
  children: [
    { id: "m-legal", label: "Legal Basis", children: [{ id: "m-1170", label: "Art. 1170 breach", children: [] }] },
    { id: "m-facts", label: "Key Facts", children: [] },
  ],
};

const reply = (labels: string[]) =>
  `[MINDMAP_CHILDREN]${JSON.stringify(labels.map((label) => ({ label, description: `${label} — per the demand letter.` })))}[/MINDMAP_CHILDREN]`;

describe("Mind map expand", () => {
  let server: WebSocketServer;
  let script: { frames: string[]; afterEnd?: string[]; afterEndDelayMs?: number };
  let prompts: string[];
  let originalWsUrl: string;

  const originals = {
    findConsultationById: ChatRepo.findConsultationById,
    findActiveForConsultation: MindMapRepo.findActiveForConsultation,
    findByMessage: MindMapRepo.findByMessage,
    findById: MindMapRepo.findById,
    saveNewVersion: MindMapRepo.saveNewVersion,
    revertOneVersion: MindMapRepo.revertOneVersion,
    writeAudit: OrganizationRepo.writeAudit,
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    resolveTenantCode: CaseAccess.resolveTenantCode,
    resolveUkJurisdiction: CaseAccess.resolveUkJurisdiction,
    lockRun: AiGenerationLockSvc.run,
    relevantChunksForCase: DocumentChunkSvc.relevantChunksForCase,
    getChatWonderSessionId: chatWonder.getChatWonderSessionId,
  };

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (raw) => {
        prompts.push(JSON.parse(raw.toString()).user_input);
        for (const frame of script.frames) socket.send(frame);
        socket.send("__END__");
        if (script.afterEnd) {
          setTimeout(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            for (const frame of script.afterEnd!) socket.send(frame);
            socket.send("[DONE]");
          }, script.afterEndDelayMs ?? 0);
        }
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

  // In-memory stand-in for MessageMindMap + MindMapRevision.
  let row: { id: string; messageId: string; data: unknown; version: number };
  let revisions: { version: number; data: unknown; reason: string }[];
  let audits: string[];
  let conflictsToInject: number;

  beforeEach(() => {
    prompts = [];
    audits = [];
    conflictsToInject = 0;
    script = { frames: [reply(["Demand letter 10 May", "No reply within 30 days"])] };
    row = { id: "mm1", messageId: "msg1", data: JSON.parse(JSON.stringify(legacyMap)), version: 1 };
    revisions = [];

    ChatRepo.findConsultationById = async () => ({ id: "c1", organizationId: "org1", caseId: "case1" }) as any;
    CaseAccess.loadAccessibleCase = async () => ({ id: "case1", caseName: "Cruz v. Reyes", actionType: "Collection of sum of money" }) as any;
    CaseAccess.resolveTenantCode = async () => "PH";
    CaseAccess.resolveUkJurisdiction = async () => null;
    AiGenerationLockSvc.run = (async (_s: string, _k: any, fn: () => Promise<unknown>) => fn()) as any;
    DocumentChunkSvc.relevantChunksForCase = async () => ({ caseDocumentIds: [], caseDocumentChunkIds: [] });
    (chatWonder as any).getChatWonderSessionId = async () => "sess-1";
    OrganizationRepo.writeAudit = (async (a: { action: string }) => {
      audits.push(a.action);
      return {};
    }) as any;
    MindMapRepo.findActiveForConsultation = async () => ({ ...row }) as any;
    MindMapRepo.findByMessage = async (_c, messageId) => (messageId === row.messageId ? ({ ...row } as any) : null);
    MindMapRepo.findById = async () => ({ ...row }) as any;
    MindMapRepo.saveNewVersion = (async (p: any) => {
      if (conflictsToInject > 0) {
        conflictsToInject--;
        // Someone else's expand lands first: the map moves on to a new version.
        const other = normalizeMindMap(row.data)!;
        findMindMapNode(other, "keyFacts")!.node.children.push({ id: "", label: "Loan of PHP 500,000", children: [] });
        row = { ...row, data: normalizeMindMap(other), version: row.version + 1 };
        throw new MindMapVersionConflictError();
      }
      if (p.expectedVersion !== row.version) throw new MindMapVersionConflictError();
      if (!revisions.some((r) => r.version === p.expectedVersion)) {
        revisions.push({ version: p.expectedVersion, data: p.previousData, reason: "generate" });
      }
      row = { ...row, data: p.data, version: p.expectedVersion + 1 };
      revisions.push({ version: row.version, data: p.data, reason: p.reason });
      return { version: row.version };
    }) as any;
    MindMapRepo.revertOneVersion = (async (_kind: string, _id: string, expected: number) => {
      const previous = [...revisions].reverse().find((r) => r.version < expected)!;
      row = { ...row, data: previous.data, version: previous.version };
      revisions = revisions.filter((r) => r.version <= previous.version);
      return { version: previous.version, data: previous.data };
    }) as any;
  });

  afterEach(() => {
    ChatRepo.findConsultationById = originals.findConsultationById;
    MindMapRepo.findActiveForConsultation = originals.findActiveForConsultation;
    MindMapRepo.findByMessage = originals.findByMessage;
    MindMapRepo.findById = originals.findById;
    MindMapRepo.saveNewVersion = originals.saveNewVersion;
    MindMapRepo.revertOneVersion = originals.revertOneVersion;
    OrganizationRepo.writeAudit = originals.writeAudit;
    CaseAccess.loadAccessibleCase = originals.loadAccessibleCase;
    CaseAccess.resolveTenantCode = originals.resolveTenantCode;
    CaseAccess.resolveUkJurisdiction = originals.resolveUkJurisdiction;
    AiGenerationLockSvc.run = originals.lockRun;
    DocumentChunkSvc.relevantChunksForCase = originals.relevantChunksForCase;
    (chatWonder as any).getChatWonderSessionId = originals.getChatWonderSessionId;
  });

  const target = { organizationId: "org1", userId: "u1", consultationId: "c1" };

  it("streamChatWonderMessage with resolveOnAnswerEnd returns at __END__ without waiting for extras", async () => {
    script = { frames: ["Just the text."], afterEnd: ['[STRUCTURED_DATA]{"mindMap":{"id":"root","label":"x","children":[]}}'], afterEndDelayMs: 1500 };
    const startedAt = Date.now();
    const result = await chatWonder.streamChatWonderMessage(
      "sess-1", "hi", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined,
      { resolveOnAnswerEnd: true },
    );
    expect(result.content).to.equal("Just the text.");
    expect(result.mindMap).to.equal(undefined);
    expect(Date.now() - startedAt).to.be.lessThan(1000);
  });

  it("adds grounded children under the node, saves a new version, and audits it", async () => {
    const result = await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis.1", count: 3 });

    expect(result.version).to.equal(2);
    expect(result.expandedNodeId).to.equal("legalBasis.1");
    const node = findMindMapNode(result.mindMap, "legalBasis.1")!.node;
    expect(node.children.map((c) => [c.id, c.label])).to.deep.equal([
      ["legalBasis.1.1", "Demand letter 10 May"],
      ["legalBasis.1.2", "No reply within 30 days"],
    ]);
    expect(node.children[0].description).to.contain("demand letter");
    // Version 1 (as generated) is backfilled so undo can reach it.
    expect(revisions.map((r) => [r.version, r.reason])).to.deep.equal([[1, "generate"], [2, "expand"]]);
    expect(audits).to.deep.equal(["mindMap.expand"]);

    const prompt = prompts[0];
    expect(prompt).to.contain("Unpaid loan › Legal Basis › Art. 1170 breach");
    expect(prompt).to.contain("Cruz v. Reyes");
    expect(prompt).to.contain("Add 3 new child nodes");
    // A chat map cites nothing, so its expand prompt asks for no sources.
    expect(prompt).to.not.contain("## DOCUMENTS");
  });

  it("accepts the model id a client holding an old, un-normalized map sends", async () => {
    const result = await MindMapSvc.expandNode({ ...target, nodeId: "m-1170" });
    expect(result.expandedNodeId).to.equal("legalBasis.1");
    expect(findMindMapNode(result.mindMap, "legalBasis.1.1")).to.not.equal(null);
  });

  it("re-applies onto the newer map when another expand lands first, without calling the model again", async () => {
    conflictsToInject = 1;
    const result = await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis.1" });
    expect(prompts).to.have.length(1);
    expect(result.version).to.equal(3);
    // Both changes survive: the other expand's child and ours.
    expect(findMindMapNode(result.mindMap, "keyFacts.1")!.node.label).to.equal("Loan of PHP 500,000");
    expect(findMindMapNode(result.mindMap, "legalBasis.1.2")!.node.label).to.equal("No reply within 30 days");
  });

  it("drops children that repeat what's already there", async () => {
    script = { frames: [reply(["Art. 1170 breach", "Demand letter 10 May"])] };
    const result = await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis" });
    expect(findMindMapNode(result.mindMap, "legalBasis")!.node.children.map((c) => c.label)).to.deep.equal([
      "Art. 1170 breach",
      "Demand letter 10 May",
    ]);
  });

  it("refuses the root (top-level branches are fixed) and unknown nodes", async () => {
    await MindMapSvc.expandNode({ ...target, nodeId: "root" }).then(
      () => expect.fail("expected a 400"),
      (err) => expect(err.statusCode).to.equal(400),
    );
    await MindMapSvc.expandNode({ ...target, nodeId: "risks.4" }).then(
      () => expect.fail("expected a 404"),
      (err) => expect(err.statusCode).to.equal(404),
    );
  });

  it("refuses with MAX_NODES before calling the model when the map is full", async () => {
    const full: any = { label: "Case", children: [{ label: "Legal Basis", children: [] }] };
    for (let i = 0; i < 148; i++) full.children.push({ label: `n${i}`, children: [] });
    row = { ...row, data: full };
    await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis" }).then(
      () => expect.fail("expected a 422"),
      (err) => {
        expect(err.statusCode).to.equal(422);
        expect(err.code).to.equal("MAX_NODES");
      },
    );
    expect(prompts).to.have.length(0);
  });

  it("502s rather than saving an empty expansion when the reply has nothing usable", async () => {
    script = { frames: ["I couldn't find anything specific in the documents."] };
    await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis" }).then(
      () => expect.fail("expected a 502"),
      (err) => expect(err.statusCode).to.equal(502),
    );
    expect(row.version).to.equal(1);
  });

  it("undo steps back to the version before the expand", async () => {
    await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis.1" });
    const undone = await MindMapSvc.revert({ ...target, expectedVersion: 2 });
    expect(undone.version).to.equal(1);
    expect(findMindMapNode(normalizeMindMap(undone.mindMap)!, "legalBasis.1")!.node.children).to.deep.equal([]);
    expect(audits).to.deep.equal(["mindMap.expand", "mindMap.revert"]);
  });

  it("refuses a stale undo (the map moved on since the client loaded it)", async () => {
    await MindMapSvc.expandNode({ ...target, nodeId: "legalBasis.1" });
    await MindMapSvc.revert({ ...target, expectedVersion: 1 }).then(
      () => expect.fail("expected a 409"),
      (err) => expect(err.statusCode).to.equal(409),
    );
    expect((row.data as MindMapItem).children).to.not.equal(undefined);
    expect(row.version).to.equal(2);
  });

  describe("manual edits", () => {
    it("renames a node and saves it as an edit revision", async () => {
      const result = await MindMapSvc.editNode({ ...target, edit: { op: "rename", nodeId: "legalBasis.1", label: "Breach of the note" } });
      expect(result.editedNodeId).to.equal("legalBasis.1");
      expect(findMindMapNode(result.mindMap, "legalBasis.1")!.node.label).to.equal("Breach of the note");
      expect(revisions.map((r) => r.reason)).to.deep.equal(["generate", "edit"]);
      expect(audits).to.deep.equal(["mindMap.edit"]);
      expect(prompts).to.have.length(0);
    });

    it("adds a point and returns the new child's id", async () => {
      const result = await MindMapSvc.editNode({ ...target, edit: { op: "add", nodeId: "keyFacts", label: "Loan of PHP 500,000" } });
      expect(result.editedNodeId).to.equal("keyFacts.1");
      expect(findMindMapNode(result.mindMap, "keyFacts.1")!.node.label).to.equal("Loan of PHP 500,000");
    });

    it("deletes a point, returning its parent", async () => {
      const result = await MindMapSvc.editNode({ ...target, edit: { op: "delete", nodeId: "legalBasis.1" } });
      expect(result.editedNodeId).to.equal("legalBasis");
      expect(findMindMapNode(result.mindMap, "legalBasis")!.node.children).to.deep.equal([]);
    });

    it("refuses to delete a top-level branch or edit the root", async () => {
      for (const edit of [
        { op: "delete" as const, nodeId: "legalBasis" },
        { op: "rename" as const, nodeId: "root", label: "x" },
      ]) {
        await MindMapSvc.editNode({ ...target, edit }).then(
          () => expect.fail("expected a 400"),
          (err) => expect(err.statusCode).to.equal(400),
        );
      }
    });

    it("refuses to add past the node cap", async () => {
      const full: any = { label: "Case", children: [{ label: "Legal Basis", children: [] }] };
      for (let i = 0; i < 148; i++) full.children.push({ label: `n${i}`, children: [] });
      row = { ...row, data: full };
      await MindMapSvc.editNode({ ...target, edit: { op: "add", nodeId: "legalBasis", label: "One more" } }).then(
        () => expect.fail("expected a 422"),
        (err) => expect(err.code).to.equal("MAX_NODES"),
      );
    });

    it("validates the request per op", () => {
      expect(editMindMapNodeSchema.validate({ op: "rename", nodeId: "a.1" }).error).to.not.equal(undefined);
      expect(editMindMapNodeSchema.validate({ op: "delete", nodeId: "a.1", label: "x" }).error).to.not.equal(undefined);
      expect(editMindMapNodeSchema.validate({ op: "add", nodeId: "a", label: " Point ", description: "" }).value.label).to.equal("Point");
      expect(editMindMapNodeSchema.validate({ op: "move", nodeId: "a" }).error).to.not.equal(undefined);
    });
  });
});
