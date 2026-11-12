/** Stopping an answer, deleting a message, and the refund rules for a client's chat (#568). A turn
 * that ends FAILED or CANCELLED gives its credit back exactly once; deleting never refunds. No live
 * Postgres: prisma.$transaction runs against a small in-memory table so IntakeChatRepo's own
 * conditional writes are what's tested; everything else is monkeypatched on its CommonJS module
 * object, same idiom as test/intake-chat.service.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import loginToken from "../src/utils/loginToken";
import IntakeChatRepo from "../src/repositories/intake-chat.repository";
import IntakeChatSvc from "../src/services/intake-chat.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import CaseRepo from "../src/repositories/case.repository";
import CaseAreaSvc from "../src/services/case-area.service";
import ClientIntakeSvc from "../src/services/client-intake.service";
import ConsentSvc from "../src/services/consent.service";
import IntakeChatGenerationQueue, { sweepStalePendingIntakeChats, type IntakeChatGenerationJob } from "../src/queues/intake-chat-generation.queue";
import * as intakeChatWonder from "../src/utils/intakeChatWonder";
import * as s3 from "../src/utils/s3";
import * as socket from "../src/lib/socket";

const CASE_ID = "case-1";
const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };

const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

type Row = {
  id: string;
  caseId: string;
  role: "user" | "assistant" | "system";
  content: string;
  replyStatus: "PENDING" | "DONE" | "FAILED" | "CANCELLED" | null;
  parentMessageId: string | null;
  audioKey: string | null;
  replyAudioKey: string | null;
};

/** The intake chat's rows and the case's credits, behind a fake prisma.$transaction that applies
 * where-clauses the way Postgres would for the handful of shapes IntakeChatRepo uses. */
let rows: Row[];
let credits: number;
let emitted: [string, string, any][];

function matches(row: Row, where: any): boolean {
  if (where.OR) return row.caseId === where.caseId && where.OR.some((w: any) => matches(row, { ...w, caseId: row.caseId }));
  if (where.id?.in) return where.id.in.includes(row.id);
  return Object.entries(where).every(([k, v]) => (row as any)[k] === v);
}

const tx = {
  intakeMessage: {
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, { replyStatus: data.replyStatus }));
      return { count: hit.length };
    },
    create: async ({ data }: any) => {
      const row: Row = { id: `assistant-${rows.length}`, audioKey: null, replyAudioKey: null, replyStatus: null, ...data };
      rows.push(row);
      return row;
    },
    findMany: async ({ where }: any) => rows.filter((r) => matches(r, where)),
    deleteMany: async ({ where }: any) => {
      const before = rows.length;
      rows = rows.filter((r) => !matches(r, where));
      return { count: before - rows.length };
    },
  },
  case: {
    update: async ({ where, data }: any) => {
      expect(where).to.deep.equal({ id: CASE_ID });
      credits += data.clientCredits.increment;
      return { clientCredits: credits };
    },
  },
};

function userTurn(id: string, replyStatus: Row["replyStatus"], extra: Partial<Row> = {}): Row {
  return { id, caseId: CASE_ID, role: "user", content: "What can I do?", replyStatus, parentMessageId: null, audioKey: null, replyAudioKey: null, ...extra };
}

function aiTurn(id: string, parentMessageId: string, extra: Partial<Row> = {}): Row {
  return { id, caseId: CASE_ID, role: "assistant", content: "You could…", replyStatus: null, parentMessageId, audioKey: null, replyAudioKey: null, ...extra };
}

const replyStateOf = async (id: string) => {
  const r = rows.find((row) => row.id === id);
  return r ? { id: r.id, caseId: r.caseId, role: r.role, userId: "u1", replyStatus: r.replyStatus, pendingReplyContent: null } : null;
};

describe("Client chat: Stop, delete and refunds (#568)", () => {
  beforeEach(() => {
    rows = [];
    credits = 10;
    emitted = [];
    stash(prisma as any, ["$transaction"]);
    (prisma as any).$transaction = async (fn: (t: typeof tx) => unknown) => fn(tx);
    stash(socket as any, ["emitToUser"]);
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
  });

  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("IntakeChatRepo.endPendingTurn", () => {
    it("ends a PENDING turn and refunds its credit", async () => {
      rows = [userTurn("m1", "PENDING")];
      expect(await IntakeChatRepo.endPendingTurn("m1", CASE_ID, "FAILED")).to.equal(true);
      expect(rows[0].replyStatus).to.equal("FAILED");
      expect(credits).to.equal(11);
    });

    for (const status of ["DONE", "FAILED", "CANCELLED"] as const) {
      it(`leaves a ${status} turn alone and refunds nothing`, async () => {
        rows = [userTurn("m1", status)];
        expect(await IntakeChatRepo.endPendingTurn("m1", CASE_ID, "CANCELLED")).to.equal(false);
        expect(rows[0].replyStatus).to.equal(status);
        expect(credits).to.equal(10);
      });
    }

    it("only touches the client's own message in this case", async () => {
      let where: any;
      (prisma as any).$transaction = async (fn: any) =>
        fn({
          ...tx,
          intakeMessage: {
            updateMany: async (args: any) => {
              where = args.where;
              return { count: 0 };
            },
          },
        });
      await IntakeChatRepo.endPendingTurn("m1", CASE_ID, "FAILED");
      expect(where).to.deep.equal({ id: "m1", caseId: CASE_ID, role: "user", replyStatus: "PENDING" });
    });
  });

  describe("IntakeChatRepo.completeTurn", () => {
    it("saves the answer and marks the turn DONE while it's still PENDING", async () => {
      rows = [userTurn("m1", "PENDING")];
      const saved = await IntakeChatRepo.completeTurn("m1", CASE_ID, "Here's what I'd do.");
      expect(saved).to.not.equal(null);
      expect(rows[0].replyStatus).to.equal("DONE");
      expect(rows.filter((r) => r.role === "assistant")).to.have.length(1);
    });

    it("drops the answer to a turn that was already stopped or failed", async () => {
      rows = [userTurn("m1", "FAILED")];
      expect(await IntakeChatRepo.completeTurn("m1", CASE_ID, "Too late.")).to.equal(null);
      expect(rows).to.have.length(1);
      expect(rows[0].replyStatus).to.equal("FAILED");
    });
  });

  describe("Stop (IntakeChatSvc.cancelIntakeGeneration)", () => {
    beforeEach(() => {
      stash(IntakeChatRepo, ["findReplyState", "findAssistantReplyByParent", "createMessage"]);
      (IntakeChatRepo as any).findReplyState = replyStateOf;
      (IntakeChatRepo as any).findAssistantReplyByParent = async () => null;
      (IntakeChatRepo as any).createMessage = async () => ({ id: "partial-1" });
    });

    it("cancels mid-answer: replyStatus CANCELLED and the credit back", async () => {
      rows = [userTurn("m1", "PENDING")];
      const res = await IntakeChatSvc.cancelIntakeGeneration(workspace, "u1", CASE_ID, "m1");
      expect(res.replyStatus).to.equal("CANCELLED");
      expect(credits).to.equal(11);
      expect(emitted.some(([, event]) => event === "chat:cancelled")).to.equal(true);
    });

    it("refunds once on a double Stop", async () => {
      rows = [userTurn("m1", "PENDING")];
      await IntakeChatSvc.cancelIntakeGeneration(workspace, "u1", CASE_ID, "m1");
      const second = await IntakeChatSvc.cancelIntakeGeneration(workspace, "u1", CASE_ID, "m1");
      expect(second).to.deep.equal({ messageId: "m1", replyStatus: "CANCELLED" });
      expect(credits).to.equal(11);
      expect(emitted.filter(([, event]) => event === "chat:cancelled")).to.have.length(1);
    });

    it("refunds nothing for an answer that already finished", async () => {
      rows = [userTurn("m1", "DONE")];
      const res = await IntakeChatSvc.cancelIntakeGeneration(workspace, "u1", CASE_ID, "m1");
      expect(res.replyStatus).to.equal("DONE");
      expect(credits).to.equal(10);
    });

    it("404s for an answer's id or a message from another case", async () => {
      rows = [userTurn("m1", "DONE"), aiTurn("a1", "m1")];
      const err = await IntakeChatSvc.cancelIntakeGeneration(workspace, "u1", CASE_ID, "a1").catch((e) => e);
      expect(err.statusCode).to.equal(404);
      const other = await IntakeChatSvc.cancelIntakeGeneration(workspace, "u1", "case-2", "m1").catch((e) => e);
      expect(other.statusCode).to.equal(404);
    });
  });

  describe("the generation worker and the stale sweep", () => {
    const JOB: IntakeChatGenerationJob = { jobId: "m1", tenantCode: "UK", userId: "u1", caseId: CASE_ID, sessionId: "s1", userInput: "What can I do?" };
    let streamCalls: number;
    let streamContexts: (string | undefined)[];
    let onStream: () => Promise<{ content: string; lawyerMatches: unknown[]; caseReady: boolean }>;

    beforeEach(() => {
      streamCalls = 0;
      streamContexts = [];
      onStream = async () => ({ content: "You could raise a grievance.", lawyerMatches: [], caseReady: false });
      stash(ConsentSvc, ["isAllowed"]);
      stash(DocumentRepo, ["listAllByCase"]);
      stash(CaseRepo, ["findOrganizationId"]);
      stash(ClientCaseRepo, ["findById"]);
      stash(CaseAreaSvc, ["labeller"]);
      stash(ClientCaseSvc, ["lawyerReadiness"]);
      stash(ClientIntakeSvc, ["scheduleAuto"]);
      stash(IntakeChatRepo, ["findReplyState", "findAssistantReplyByParent", "listByCase", "findStalePending"]);
      stash(intakeChatWonder as any, ["streamIntakeChatWonderMessage"]);
      (ConsentSvc as any).isAllowed = async () => true;
      (DocumentRepo as any).listAllByCase = async () => [];
      (CaseRepo as any).findOrganizationId = async () => null;
      (ClientCaseRepo as any).findById = async () => null;
      (CaseAreaSvc as any).labeller = async () => () => [];
      (ClientCaseSvc as any).lawyerReadiness = async () => ({ enabled: false, ready: false, criteria: [] });
      (ClientIntakeSvc as any).scheduleAuto = async () => undefined;
      (IntakeChatRepo as any).findReplyState = replyStateOf;
      (IntakeChatRepo as any).findAssistantReplyByParent = async (parent: string) => rows.find((r) => r.parentMessageId === parent) ?? null;
      (IntakeChatRepo as any).listByCase = async () => rows;
      (IntakeChatRepo as any).findStalePending = async () => rows.filter((r) => r.replyStatus === "PENDING").map((r) => ({ id: r.id, caseId: r.caseId, userId: "u1" }));
      (intakeChatWonder as any).streamIntakeChatWonderMessage = async (_s: string, _u: string, _c: unknown, context: string | undefined) => {
        streamCalls++;
        streamContexts.push(context);
        return onStream();
      };
    });

    it("refunds an answer the AI fails to give", async () => {
      rows = [userTurn("m1", "PENDING")];
      onStream = async () => {
        throw new Error("Chat Wonder unavailable");
      };
      await IntakeChatSvc.processIntakeGenerationJob(JOB).catch(() => undefined);
      expect(rows[0].replyStatus).to.equal("FAILED");
      expect(credits).to.equal(11);
      expect(emitted.some(([, event]) => event === "chat:error")).to.equal(true);
    });

    it("refunds a turn whose AI-processing consent was withdrawn", async () => {
      rows = [userTurn("m1", "PENDING")];
      (ConsentSvc as any).isAllowed = async () => false;
      await IntakeChatSvc.processIntakeGenerationJob(JOB);
      expect(rows[0].replyStatus).to.equal("FAILED");
      expect(credits).to.equal(11);
      expect(streamCalls).to.equal(0);
    });

    it("the sweep fails and refunds a stuck turn once, and says so once", async () => {
      rows = [userTurn("m1", "PENDING")];
      await sweepStalePendingIntakeChats();
      // A late failure from the worker, after the sweep, refunds nothing more.
      expect(await IntakeChatRepo.endPendingTurn("m1", CASE_ID, "FAILED")).to.equal(false);
      expect(rows[0].replyStatus).to.equal("FAILED");
      expect(credits).to.equal(11);
      expect(emitted.filter(([, event]) => event === "chat:error")).to.have.length(1);
    });

    it("the sweep stays silent about a turn that ended between its read and its write", async () => {
      rows = [userTurn("m1", "PENDING")];
      (IntakeChatRepo as any).findStalePending = async () => {
        rows[0].replyStatus = "DONE";
        return [{ id: "m1", caseId: CASE_ID, userId: "u1" }];
      };
      await sweepStalePendingIntakeChats();
      expect(credits).to.equal(10);
      expect(emitted).to.have.length(0);
    });

    it("never answers a redelivered turn that already failed (and was refunded)", async () => {
      rows = [userTurn("m1", "FAILED")];
      await IntakeChatSvc.processIntakeGenerationJob(JOB);
      expect(streamCalls).to.equal(0);
      expect(rows).to.have.length(1);
      expect(credits).to.equal(10);
    });

    it("drops a late answer to a turn the sweep failed while it was being written", async () => {
      rows = [userTurn("m1", "PENDING")];
      onStream = async () => {
        await sweepStalePendingIntakeChats();
        return { content: "Here's my late answer.", lawyerMatches: [], caseReady: false };
      };
      await IntakeChatSvc.processIntakeGenerationJob(JOB);
      expect(rows.filter((r) => r.role === "assistant")).to.have.length(0);
      expect(rows[0].replyStatus).to.equal("FAILED");
      expect(credits).to.equal(11);
      expect(emitted.some(([, event]) => event === "chat:done")).to.equal(false);
    });

    it("saves a normal answer without refunding", async () => {
      rows = [userTurn("m1", "PENDING")];
      await IntakeChatSvc.processIntakeGenerationJob(JOB);
      expect(rows[0].replyStatus).to.equal("DONE");
      expect(rows.filter((r) => r.role === "assistant")).to.have.length(1);
      expect(credits).to.equal(10);
      expect(emitted.some(([, event]) => event === "chat:done")).to.equal(true);
    });

    it("hands a new session the chat so far (replayHistory), and an existing one nothing extra", async () => {
      rows = [userTurn("m0", "DONE", { content: "My boss fired me." }), aiTurn("a0", "m0", { content: "When was that?" }), userTurn("m1", "PENDING")];
      await IntakeChatSvc.processIntakeGenerationJob({ ...JOB, replayHistory: true });
      expect(streamContexts[0]).to.include("Client: My boss fired me.\nYou: When was that?");

      rows = [userTurn("m0", "DONE", { content: "My boss fired me." }), userTurn("m1", "PENDING")];
      await IntakeChatSvc.processIntakeGenerationJob(JOB);
      expect(streamContexts[1] ?? "").not.to.include("Earlier conversation");
    });
  });

  describe("IntakeChatSvc.enqueueIntakeGeneration: which session a turn uses", () => {
    let enqueued: IntakeChatGenerationJob[];
    let cached: string | null;

    beforeEach(() => {
      enqueued = [];
      stash(redis as any, ["get", "set"]);
      stash(intakeChatWonder as any, ["getChatWonderSessionIdForIntake"]);
      stash(IntakeChatRepo, ["createUserMessageIfNoPendingTurn"]);
      stash(IntakeChatGenerationQueue as any, ["enqueue"]);
      (redis as any).get = async () => cached;
      (redis as any).set = async () => undefined;
      (intakeChatWonder as any).getChatWonderSessionIdForIntake = async () => "new-session";
      (IntakeChatRepo as any).createUserMessageIfNoPendingTurn = async () => ({ id: "m9" });
      (IntakeChatGenerationQueue as any).enqueue = (job: IntakeChatGenerationJob) => void enqueued.push(job);
    });

    it("asks a new session to replay the chat", async () => {
      cached = null;
      await IntakeChatSvc.enqueueIntakeGeneration(workspace, "u1", CASE_ID, "Hello again");
      expect(enqueued[0]).to.include({ sessionId: "new-session", replayHistory: true });
    });

    it("leaves a known session alone", async () => {
      cached = "s1";
      await IntakeChatSvc.enqueueIntakeGeneration(workspace, "u1", CASE_ID, "Hello again");
      expect(enqueued[0].sessionId).to.equal("s1");
      expect(enqueued[0].replayHistory).to.equal(undefined);
    });
  });

  describe("Delete (IntakeChatSvc.deleteMessage)", () => {
    let droppedSessions: string[];
    let removedAudio: string[];

    beforeEach(() => {
      droppedSessions = [];
      removedAudio = [];
      stash(IntakeChatRepo, ["findInCase"]);
      stash(redis as any, ["del"]);
      stash(s3 as any, ["deleteFromS3"]);
      (IntakeChatRepo as any).findInCase = async (id: string, caseId: string) => {
        const r = rows.find((row) => row.id === id && row.caseId === caseId);
        return r ? { id: r.id, role: r.role, replyStatus: r.replyStatus } : null;
      };
      (redis as any).del = async (key: string) => void droppedSessions.push(key);
      (s3 as any).deleteFromS3 = async (key: string) => void removedAudio.push(key);
    });

    it("deletes the client's message with its answer, and the AI's session with them, without a refund", async () => {
      rows = [userTurn("m1", "DONE"), aiTurn("a1", "m1"), userTurn("m2", "DONE")];
      await IntakeChatSvc.deleteMessage(workspace, CASE_ID, "m1");
      expect(rows.map((r) => r.id)).to.deep.equal(["m2"]);
      expect(droppedSessions).to.deep.equal([`chatwonder:session:intake:${CASE_ID}`]);
      expect(credits).to.equal(10);
    });

    it("deletes just an answer when that's what was picked", async () => {
      rows = [userTurn("m1", "DONE"), aiTurn("a1", "m1")];
      await IntakeChatSvc.deleteMessage(workspace, CASE_ID, "a1");
      expect(rows.map((r) => r.id)).to.deep.equal(["m1"]);
    });

    it("removes a voice turn's recordings, and carries on if S3 refuses", async () => {
      rows = [userTurn("m1", "DONE", { audioKey: "voice-messages/case-1/rec.webm" }), aiTurn("a1", "m1", { replyAudioKey: "voice-messages/case-1/a1-reply.mp3" })];
      (s3 as any).deleteFromS3 = async (key: string) => {
        removedAudio.push(key);
        throw new Error("S3 down");
      };
      await IntakeChatSvc.deleteMessage(workspace, CASE_ID, "m1");
      expect(removedAudio).to.have.members(["voice-messages/case-1/rec.webm", "voice-messages/case-1/a1-reply.mp3"]);
      expect(rows).to.have.length(0);
    });

    it("refuses while the answer is still being written (409 TURN_IN_PROGRESS)", async () => {
      rows = [userTurn("m1", "PENDING")];
      const err = await IntakeChatSvc.deleteMessage(workspace, CASE_ID, "m1").catch((e) => e);
      expect(err.statusCode).to.equal(409);
      expect(err.code).to.equal("TURN_IN_PROGRESS");
      expect(rows).to.have.length(1);
    });

    it("404s for a message from another case", async () => {
      rows = [{ ...userTurn("m1", "DONE"), caseId: "case-2" }];
      const err = await IntakeChatSvc.deleteMessage(workspace, CASE_ID, "m1").catch((e) => e);
      expect(err.statusCode).to.equal(404);
      expect(rows).to.have.length(1);
    });
  });

  describe("the client routes", () => {
    let role: string;
    let cancelled: unknown[] | null;
    let deleted: unknown[] | null;
    const auth = (as: string) => ({ Authorization: `Bearer ${loginToken(as).accessToken}` });
    const cancel = (as: string) => request(app).post(`/api/client/cases/${CASE_ID}/messages/m1/cancel`).set(auth(as));
    const remove = (as: string) => request(app).delete(`/api/client/cases/${CASE_ID}/messages/m1`).set(auth(as));

    beforeEach(() => {
      role = "USER";
      cancelled = null;
      deleted = null;
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      stash(ClientCaseRepo, ["findById"]);
      stash(IntakeChatSvc, ["cancelIntakeGeneration", "deleteMessage"]);
      (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...workspace, id: userId === "other-client" ? "org-2" : workspace.id });
      (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (id === CASE_ID && orgId === workspace.id ? { id: CASE_ID, caseName: "Fired by my boss" } : null);
      (IntakeChatSvc as any).cancelIntakeGeneration = async (...args: unknown[]) => {
        cancelled = args;
        return { messageId: "m1", replyStatus: "CANCELLED", assistantMessageId: "partial-1" };
      };
      (IntakeChatSvc as any).deleteMessage = async (...args: unknown[]) => {
        deleted = args;
      };
    });

    it("stops an answer for the client who owns the case", async () => {
      const res = await cancel("client");
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ messageId: "m1", replyStatus: "CANCELLED", assistantMessageId: "partial-1" });
      expect(cancelled?.slice(1)).to.deep.equal(["client", CASE_ID, "m1"]);
    });

    it("deletes a message for the client who owns the case", async () => {
      const res = await remove("client");
      expect(res.status).to.equal(204);
      expect(deleted?.slice(1)).to.deep.equal([CASE_ID, "m1"]);
    });

    for (const [name, send] of [
      ["Stop", cancel],
      ["delete", remove],
    ] as const) {
      it(`${name}: refuses a lawyer with 403 CLIENT_ACCOUNT_ONLY`, async () => {
        role = "LAWYER";
        const res = await send("lawyer");
        expect(res.status).to.equal(403);
        expect(res.body.code).to.equal("CLIENT_ACCOUNT_ONLY");
        expect(cancelled ?? deleted).to.equal(null);
      });

      it(`${name}: 404s for another client`, async () => {
        expect((await send("other-client")).status).to.equal(404);
        expect(cancelled ?? deleted).to.equal(null);
      });
    }
  });
});
