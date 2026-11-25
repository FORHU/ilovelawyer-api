/** The evidence step's suggestions (ClientEvidenceSvc, /api/client/cases/:caseId/evidence-suggestions)
 * and its pure half (utils/client-evidence-plan.ts). No live Postgres: repositories and services are
 * monkeypatched on their CommonJS module objects, same idiom as test/client-questions.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientEvidenceSvc, { stateOf } from "../src/services/client-evidence.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import CaseAreaSvc from "../src/services/case-area.service";
import MissingEvidenceRepo from "../src/repositories/missing-evidence.repository";
import IntakeChatRepo from "../src/repositories/intake-chat.repository";
import ConsentRepo from "../src/repositories/consent.repository";
import * as chatWonder from "../src/utils/chatWonder";
import { CLIENT_INTAKE_EVIDENCE_NOTE } from "../src/constants/missing-evidence.constants";
import { MAX_SUGGESTIONS, NOTE_MAX_CHARS, buildEvidencePrompt, buildNotePrompt, generalSuggestions, parseEvidenceReply, parseNoteReply } from "../src/utils/client-evidence-plan";
import DocumentNoteRepo from "../src/repositories/document-note.repository";
import DocumentSvc from "../src/services/document.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientIntakeSvc, { fingerprintOf } from "../src/services/client-intake.service";
import * as excerpts from "../src/utils/case-document-excerpts";
import { buildIntakePrompt } from "../src/utils/client-intake-extract";
import { ALLOWED_DOCUMENT_EXTENSIONS, MEDIA_DOCUMENT_EXTENSIONS, MEDIA_DOCUMENT_MIME_TYPES } from "../src/constants/document-upload.constants";

const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

const UK: ClientWorkspace = { id: "org-1", role: "OWNER", tenantCode: "UK" };
const CASE_ID = "case-1";
const STORY = "My manager let me go on 3 March with no written notice. They still owe me two months' pay.";

const row = (over: Record<string, unknown> = {}) => ({
  id: "gap-1",
  caseId: CASE_ID,
  label: "Payslips",
  detail: "Shows the pay they still owe you.",
  suggestedSource: "photos",
  notes: CLIENT_INTAKE_EVIDENCE_NOTE,
  filledByDocumentId: null,
  clientDismissedAt: null,
  ...over,
});

describe("Client evidence", () => {
  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("parseEvidenceReply", () => {
    it("keeps the AI's suggestions in order, with a known source, at most five", () => {
      const reply = JSON.stringify({
        suggestions: [
          { title: "Payslips", why: "Shows the pay they still owe you.", source: "photos" },
          { title: "Messages from your manager", why: "Shows how you were let go.", source: "email" },
          { title: "payslips", why: "A repeat.", source: "photos" },
          { title: "Your contract", why: "Shows what was agreed.", source: "a fax" },
          { title: "What your manager said", why: "Only you remember it.", source: "memo" },
          { title: "Bank statements", why: "Shows the pay that stopped.", source: "files" },
          { title: "One too many", why: "", source: "files" },
        ],
      });
      const { suggestions, fromAi } = parseEvidenceReply(reply, "en");
      expect(fromAi).to.equal(true);
      expect(suggestions).to.have.length(MAX_SUGGESTIONS);
      expect(suggestions.map((s) => [s.title, s.source])).to.deep.equal([
        ["Payslips", "photos"],
        ["Messages from your manager", "email"],
        ["Your contract", "files"],
        ["What your manager said", "memo"],
        ["Bank statements", "files"],
      ]);
    });

    it("leaves out suggestions in another language, and keeps a title whose why is", () => {
      const reply = JSON.stringify({
        suggestions: [
          { title: "工資單", why: "顯示欠款。", source: "photos" },
          { title: "Payslips", why: "顯示欠款。", source: "photos" },
          { title: "Messages from HR", why: "Shows when you were let go.", source: "email" },
        ],
      });
      const { suggestions } = parseEvidenceReply(reply, "en");
      expect(suggestions).to.deep.equal([
        { title: "Payslips", why: "", source: "photos" },
        { title: "Messages from HR", why: "Shows when you were let go.", source: "email" },
      ]);
    });

    it("uses the app's general suggestions, in the story's language, when too few are usable", () => {
      expect(parseEvidenceReply("not json", "en")).to.deep.equal({ suggestions: generalSuggestions("en"), fromAi: false });
      const one = parseEvidenceReply(JSON.stringify({ suggestions: [{ title: "Payslips", why: "", source: "photos" }] }), "ko");
      expect(one.fromAi).to.equal(false);
      expect(one.suggestions[0]!.title).to.equal("상대방과 주고받은 메시지");
    });
  });

  describe("buildEvidencePrompt", () => {
    it("names the story's language, the documents already there, and the sources to choose from", () => {
      const prompt = buildEvidencePrompt({ tenantCode: "KR", caseDetails: "Known case details: …", conversation: `Client: ${STORY}`, documents: ["contract.pdf"], today: "2026-03-05", language: "ko" });
      expect(prompt).to.include("in Korean only");
      expect(prompt).to.include("Documents already on the case: contract.pdf");
      expect(prompt).to.include(`Client: ${STORY}`);
      expect(prompt).to.include('"memo"');
      expect(prompt).to.include("must not predict an outcome");
    });
  });

  describe("stateOf", () => {
    it("shows each suggestion as open, added (a document fills it) or dismissed, and counts them", () => {
      const state = stateOf([
        row({ id: "a" }),
        row({ id: "b", filledByDocumentId: "doc-1", clientDismissedAt: new Date() }),
        row({ id: "c", clientDismissedAt: new Date(), suggestedSource: "unknown" }),
      ] as any);
      expect(state.suggestions.map((s) => [s.id, s.state, s.source, s.documentId])).to.deep.equal([
        ["a", "OPEN", "photos", null],
        ["b", "ADDED", "photos", "doc-1"],
        ["c", "DISMISSED", "files", null],
      ]);
      expect(state).to.deep.include({ added: 1, open: 1 });
    });
  });

  describe("the service", () => {
    let rows: any[];
    let created: any[];
    let prompts: string[];
    let aiReply: unknown;
    let aiFails: boolean;

    beforeEach(() => {
      stash(ClientCaseSvc, ["load"]);
      stash(CaseAreaSvc, ["refsOf"]);
      stash(MissingEvidenceRepo, ["listClientIntake", "createClientIntakeOnce", "setClientDismissed"]);
      stash(IntakeChatRepo, ["listByCase"]);
      stash(chatWonder, ["callChatWonderRest", "getChatWonderSessionId"]);

      rows = [];
      created = [];
      prompts = [];
      aiFails = false;
      aiReply = {
        suggestions: [
          { title: "Payslips", why: "Shows the pay they still owe you.", source: "photos" },
          { title: "Messages from your manager", why: "Shows how you were let go.", source: "email" },
        ],
      };

      (ClientCaseSvc as any).load = async (ws: ClientWorkspace, caseId: string) => {
        if (caseId !== CASE_ID || ws.id !== UK.id) throw Object.assign(new Error("Case not found"), { statusCode: 404 });
        return {
          id: CASE_ID, caseName: "Dismissed", caseAreas: ["EMPLOYMENT"], clientCaseAreas: [], ukJurisdiction: "England and Wales", outsideUk: false,
          jurisdiction: "Leeds", clientSide: null, notes: null, parties: [], documents: [{ name: "contract.pdf" }],
        };
      };
      (CaseAreaSvc as any).refsOf = async (codes: string[]) => codes.map((code) => ({ code, name: "Employment" }));
      (MissingEvidenceRepo as any).listClientIntake = async () => rows;
      (MissingEvidenceRepo as any).createClientIntakeOnce = async (_caseId: string, data: any[]) => {
        created.push(...data);
        if (!rows.length) rows = data.map((d, i) => row({ id: `gap-${i + 1}`, label: d.label, detail: d.detail, suggestedSource: d.suggestedSource }));
        return rows;
      };
      (MissingEvidenceRepo as any).setClientDismissed = async (id: string, _caseId: string, at: Date | null) => {
        const r = rows.find((x) => x.id === id);
        if (!r) return false;
        r.clientDismissedAt = at;
        return true;
      };
      (IntakeChatRepo as any).listByCase = async () => [
        { id: "m1", role: "user", content: STORY },
        { id: "m2", role: "assistant", content: "What was your job, and your pay?" },
        { id: "m3", role: "user", content: "Under £20,000" },
      ];
      (chatWonder as any).getChatWonderSessionId = async () => "s1";
      (chatWonder as any).callChatWonderRest = async (prompt: string) => {
        prompts.push(prompt);
        if (aiFails) throw new Error("Chat Wonder down");
        return { response: JSON.stringify(aiReply) };
      };
    });

    it("suggests once from the story and the answers, saving them as the case's gaps", async () => {
      const state = await ClientEvidenceSvc.start(UK, "user-1", CASE_ID);
      expect(prompts).to.have.length(1);
      expect(prompts[0]).to.include("Client: Under £20,000");
      expect(prompts[0]).to.include("Documents already on the case: contract.pdf");
      expect(prompts[0]).to.include("in English only");
      expect(created).to.deep.equal([
        { label: "Payslips", detail: "Shows the pay they still owe you.", suggestedSource: "photos" },
        { label: "Messages from your manager", detail: "Shows how you were let go.", suggestedSource: "email" },
      ]);
      expect(state.suggestions.map((s) => s.title)).to.deep.equal(["Payslips", "Messages from your manager"]);
      expect(state).to.deep.include({ added: 0, open: 2 });

      // Coming back returns the same ones, with no second call.
      await ClientEvidenceSvc.start(UK, "user-1", CASE_ID);
      expect(prompts).to.have.length(1);
    });

    it("saves the general suggestions when the reply has too few usable ones", async () => {
      aiReply = { suggestions: [] };
      const state = await ClientEvidenceSvc.start(UK, "user-1", CASE_ID);
      expect(state.suggestions.map((s) => s.title)).to.deep.equal(generalSuggestions("en").map((s) => s.title));
    });

    it("saves nothing when the call fails (502), so the next start tries again", async () => {
      aiFails = true;
      expect(await errorOf(ClientEvidenceSvc.start(UK, "user-1", CASE_ID))).to.deep.equal({ status: 502, code: "EVIDENCE_FAILED" });
      expect(created).to.deep.equal([]);
    });

    it("reads without suggesting: null before there are any", async () => {
      expect(await ClientEvidenceSvc.read(UK, CASE_ID)).to.equal(null);
      expect(prompts).to.deep.equal([]);
      rows = [row()];
      expect((await ClientEvidenceSvc.read(UK, CASE_ID))!.suggestions).to.have.length(1);
    });

    it("marks one \"I don't have this\", and takes it back", async () => {
      rows = [row({ id: "gap-1" }), row({ id: "gap-2", label: "Contract" })];
      let state = await ClientEvidenceSvc.setDismissed(UK, CASE_ID, "gap-1", true);
      expect(state.suggestions[0]!.state).to.equal("DISMISSED");
      expect(state.open).to.equal(1);
      state = await ClientEvidenceSvc.setDismissed(UK, CASE_ID, "gap-1", false);
      expect(state.suggestions[0]!.state).to.equal("OPEN");
      expect((await errorOf(ClientEvidenceSvc.setDismissed(UK, CASE_ID, "someone-elses", true)))?.status).to.equal(404);
    });

    it("is refused on a site whose AI isn't open, and 404s for another client's case", async () => {
      expect(await errorOf(ClientEvidenceSvc.start({ ...UK, tenantCode: "PH" }, "user-1", CASE_ID))).to.deep.equal({ status: 403, code: "CLIENT_AI_NOT_OPEN" });
      expect((await errorOf(ClientEvidenceSvc.read({ ...UK, id: "org-2" }, CASE_ID)))?.status).to.equal(404);
    });
  });

  describe("notes", () => {
    it("asks for a first-person note in the story's language, with what was read and what it fills", () => {
      const prompt = buildNotePrompt({ name: "payslip.jpg", category: "Payslip", content: "Net pay £1,850", fills: "Payslips", story: STORY, language: "ko" });
      expect(prompt).to.include("payslip.jpg (Payslip), added as: Payslips");
      expect(prompt).to.include("Net pay £1,850");
      expect(prompt).to.include("in Korean only");
      expect(prompt).to.include("first person");
    });

    it("takes a short note in the right language, and nothing else", () => {
      expect(parseNoteReply('{"note": "My last payslip, for December 2025."}', "en")).to.equal("My last payslip, for December 2025.");
      expect(parseNoteReply('{"note": "我的工資單。"}', "en")).to.equal(null);
      expect(parseNoteReply(JSON.stringify({ note: "x".repeat(NOTE_MAX_CHARS + 1) }), "en")).to.equal(null);
      expect(parseNoteReply('{"note": ""}', "en")).to.equal(null);
      expect(parseNoteReply("no json", "en")).to.equal(null);
    });

    describe("drafting", () => {
      let suggestions: any[];
      let docs: any[];
      let saved: [string, string | null][];
      let prompts: string[];
      let fails: boolean;

      beforeEach(() => {
        stash(MissingEvidenceRepo, ["listClientIntake"]);
        stash(DocumentNoteRepo, ["listNeedingDraft", "saveDraft"]);
        stash(IntakeChatRepo, ["listByCase"]);
        stash(excerpts, ["buildFactExcerptPack"]);
        stash(chatWonder, ["callChatWonderRest", "getChatWonderSessionId"]);
        suggestions = [row({ id: "gap-1", label: "Payslips", filledByDocumentId: "doc-1" })];
        docs = [
          { id: "doc-1", name: "payslip.jpg", category: "Payslip" },
          { id: "doc-2", name: "blurry.jpg", category: null },
        ];
        saved = [];
        prompts = [];
        fails = false;
        (MissingEvidenceRepo as any).listClientIntake = async () => suggestions;
        (DocumentNoteRepo as any).listNeedingDraft = async () => docs;
        (DocumentNoteRepo as any).saveDraft = async (id: string, note: string | null) => {
          saved.push([id, note]);
          return true;
        };
        (IntakeChatRepo as any).listByCase = async () => [{ id: "m1", role: "user", content: STORY }];
        (excerpts as any).buildFactExcerptPack = async ([doc]: { id: string }[]) => ({ text: doc!.id === "doc-1" ? "Net pay £1,850" : "", chunkIds: [], factCount: 0 });
        (chatWonder as any).getChatWonderSessionId = async () => "s1";
        (chatWonder as any).callChatWonderRest = async (prompt: string) => {
          prompts.push(prompt);
          if (fails) throw new Error("Chat Wonder down");
          return { response: prompt.includes("blurry.jpg") ? '{"note": ""}' : '{"note": "My last payslip, for December 2025."}' };
        };
      });

      it("drafts each newly read document's note, saving an empty one as tried", async () => {
        expect(await ClientEvidenceSvc.draftNotes(CASE_ID, "user-1")).to.equal(1);
        expect(prompts[0]).to.include("added as: Payslips");
        expect(saved).to.deep.equal([
          ["doc-1", "My last payslip, for December 2025."],
          ["doc-2", null],
        ]);
      });

      it("drafts nothing on a case that isn't in the evidence step", async () => {
        suggestions = [];
        expect(await ClientEvidenceSvc.draftNotes(CASE_ID, "user-1")).to.equal(0);
        expect(prompts).to.deep.equal([]);
      });

      it("leaves a document to try again when the call fails, and never throws", async () => {
        fails = true;
        expect(await ClientEvidenceSvc.draftNotes(CASE_ID, "user-1")).to.equal(0);
        expect(saved).to.deep.equal([]);
      });
    });

    it("saves the client's own note, and 404s for a document not on the case", async () => {
      stash(ClientCaseSvc, ["load"]);
      stash(DocumentNoteRepo, ["saveClientNote"]);
      (ClientCaseSvc as any).load = async () => ({ id: CASE_ID });
      const calls: unknown[] = [];
      (DocumentNoteRepo as any).saveClientNote = async (id: string, caseId: string, note: string) => {
        calls.push([id, caseId, note]);
        return id === "doc-1";
      };
      expect(await ClientEvidenceSvc.setNote(UK, CASE_ID, "doc-1", "  My contract  ")).to.deep.equal({ documentId: "doc-1", note: "My contract", noteBy: "CLIENT" });
      expect(await ClientEvidenceSvc.setNote(UK, CASE_ID, "doc-1", "   ")).to.deep.equal({ documentId: "doc-1", note: null, noteBy: "CLIENT" });
      expect(calls).to.deep.equal([
        ["doc-1", CASE_ID, "My contract"],
        ["doc-1", CASE_ID, ""],
      ]);
      expect((await errorOf(ClientEvidenceSvc.setNote(UK, CASE_ID, "doc-9", "x")))?.status).to.equal(404);
    });

    it("removing a document asks again for the proof it was added for", async () => {
      stash(ClientCaseSvc, ["loadDocument"]);
      stash(DocumentSvc, ["delete"]);
      stash(MissingEvidenceRepo, ["clearFilledByDocument"]);
      stash(ClientRequestRepo, ["findEngagedLawyerForCase"]);
      const calls: unknown[] = [];
      (ClientCaseSvc as any).loadDocument = async () => ({ id: "doc-1", name: "payslip.jpg" });
      (DocumentSvc as any).delete = async (id: string) => void calls.push(["delete", id]);
      (MissingEvidenceRepo as any).clearFilledByDocument = async (caseId: string, id: string) => void calls.push(["clear", caseId, id]);
      (ClientRequestRepo as any).findEngagedLawyerForCase = async () => null;
      await ClientCaseSvc.removeDocument(UK, "user-1", CASE_ID, "doc-1");
      // Only once the document is really gone.
      expect(calls).to.deep.equal([
        ["delete", "doc-1"],
        ["clear", CASE_ID, "doc-1"],
      ]);
    });

    it("Done reads the case once over the new proof", async () => {
      stash(ClientCaseSvc, ["load"]);
      stash(ClientIntakeSvc, ["scheduleAuto"]);
      stash(MissingEvidenceRepo, ["listClientIntake"]);
      (ClientCaseSvc as any).load = async () => ({ id: CASE_ID });
      const reasons: string[] = [];
      (ClientIntakeSvc as any).scheduleAuto = async (_c: string, _u: string, reason: string) => void reasons.push(reason);
      (MissingEvidenceRepo as any).listClientIntake = async () => [row()];
      const state = await ClientEvidenceSvc.done(UK, "user-1", CASE_ID);
      expect(reasons).to.deep.equal(["evidence"]);
      expect(state!.suggestions).to.have.length(1);
    });

    it("puts each document's note beside its name for the intake reading", () => {
      const prompt = buildIntakePrompt({
        caseDetails: { title: "t", caseAreas: [], ukJurisdiction: null, where: null, side: null, notes: null },
        parties: [],
        messages: [],
        documents: [
          { id: "doc-1", name: "payslip.jpg", note: "My last payslip." },
          { id: "doc-2", name: "contract.pdf", note: null },
        ],
        documentExcerpts: "",
        today: "2026-03-05",
      });
      expect(prompt).to.include("D1: payslip.jpg (the client's note: My last payslip.)");
      expect(prompt).to.include("D2: contract.pdf\n");
    });

    it("counts notes in the reading's fingerprint only on a case that has any", async () => {
      const source = (docs: Record<string, unknown>[]) => ({
        id: CASE_ID, caseName: "t", caseAreas: [], ukJurisdiction: null, outsideUk: false, jurisdiction: null, clientSide: null, notes: null,
        lawyerReadiness: null, parties: [], documents: docs,
      });
      const doc = (clientNote?: string | null) => ({ id: "doc-0", name: "x", ragStatus: "READY", ...(clientNote === undefined ? {} : { clientNote }) });
      const withoutNotes = await fingerprintOf(source([doc(null)]) as any, "m1");
      const withNote = await fingerprintOf(source([doc("enc1:a")]) as any, "m1");
      const changedNote = await fingerprintOf(source([doc("enc1:b")]) as any, "m1");
      expect(withNote).to.not.equal(withoutNotes);
      expect(changedNote).to.not.equal(withNote);
      // A case with no notes keeps the fingerprint it had before notes existed.
      expect(withoutNotes).to.equal(await fingerprintOf(source([doc()]) as any, "m1"));
    });
  });

  describe("voice memos", () => {
    it("accepts a webm recording as a media document, to be transcribed", () => {
      expect(ALLOWED_DOCUMENT_EXTENSIONS).to.include("webm");
      expect(MEDIA_DOCUMENT_EXTENSIONS).to.include("webm");
      expect(MEDIA_DOCUMENT_MIME_TYPES).to.include("audio/webm");
    });
  });

  describe("the routes", () => {
    let sensitiveAgreed: boolean;
    const auth = (as: string) => ({ Authorization: `Bearer ${loginToken(as).accessToken}` });

    beforeEach(() => {
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      stash(ConsentRepo, ["find"]);
      stash(ClientEvidenceSvc, ["start", "read", "setDismissed"]);
      sensitiveAgreed = true;
      (prisma.user as any).findUnique = async () => ({ role: "USER", name: "Sam Client", username: "sam.1234" });
      (ConsentRepo as any).find = async (_userId: string, purpose: string) => (purpose === "SENSITIVE_INFO" && sensitiveAgreed ? { withdrawnAt: null } : null);
      (ClientCaseSvc as any).workspaceFor = async () => UK;
      (ClientEvidenceSvc as any).start = async () => ({ suggestions: [], added: 0, open: 0 });
      (ClientEvidenceSvc as any).read = async () => null;
      (ClientEvidenceSvc as any).setDismissed = async (_ws: unknown, _c: string, id: string, dismissed: boolean) => ({ id, dismissed });
    });

    it("starts with consent, refuses without it, and reads without needing it", async () => {
      expect((await request(app).post(`/api/client/cases/${CASE_ID}/evidence-suggestions`).set(auth("ev-1"))).status).to.equal(200);
      sensitiveAgreed = false;
      const refused = await request(app).post(`/api/client/cases/${CASE_ID}/evidence-suggestions`).set(auth("ev-2"));
      expect(refused.status).to.equal(403);
      expect(refused.body.code).to.equal("CONSENT_REQUIRED");
      const read = await request(app).get(`/api/client/cases/${CASE_ID}/evidence-suggestions`).set(auth("ev-2"));
      expect(read.status).to.equal(200);
      expect(read.body).to.equal(null);
    });

    it("saves a document note without needing consent, refusing one that's too long", async () => {
      stash(ClientEvidenceSvc, ["setNote"]);
      (ClientEvidenceSvc as any).setNote = async (_ws: unknown, _c: string, documentId: string, note: string) => ({ documentId, note, noteBy: "CLIENT" });
      sensitiveAgreed = false;
      const ok = await request(app).patch(`/api/client/cases/${CASE_ID}/documents/doc-1/note`).set(auth("ev-4")).send({ note: "My contract" });
      expect(ok.status).to.equal(200);
      expect(ok.body).to.deep.equal({ documentId: "doc-1", note: "My contract", noteBy: "CLIENT" });
      expect((await request(app).patch(`/api/client/cases/${CASE_ID}/documents/doc-1/note`).set(auth("ev-4")).send({ note: "x".repeat(501) })).status).to.equal(400);
    });

    it("Done needs consent, since it reads the case again", async () => {
      stash(ClientEvidenceSvc, ["done"]);
      (ClientEvidenceSvc as any).done = async () => null;
      expect((await request(app).post(`/api/client/cases/${CASE_ID}/evidence/done`).set(auth("ev-5"))).status).to.equal(200);
      sensitiveAgreed = false;
      expect((await request(app).post(`/api/client/cases/${CASE_ID}/evidence/done`).set(auth("ev-6"))).body.code).to.equal("CONSENT_REQUIRED");
    });

    it("dismisses with a yes or no, and refuses anything else", async () => {
      const ok = await request(app).patch(`/api/client/cases/${CASE_ID}/evidence-suggestions/gap-1`).set(auth("ev-3")).send({ dismissed: true });
      expect(ok.body).to.deep.equal({ id: "gap-1", dismissed: true });
      expect((await request(app).patch(`/api/client/cases/${CASE_ID}/evidence-suggestions/gap-1`).set(auth("ev-3")).send({})).status).to.equal(400);
    });
  });
});
