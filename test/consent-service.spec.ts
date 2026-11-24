/** ConsentSvc — what a user has agreed to, per purpose. No live Postgres: the repo is
 * monkeypatched on its CommonJS module object, same idiom as test/admin-change-tenant.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { ConsentPurpose } from "@prisma/client";
import ConsentSvc from "../src/services/consent.service";
import ConsentRepo from "../src/repositories/consent.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import GmailConnectionSvc from "../src/services/gmail-connection.service";
import DocumentExtractionQueue from "../src/queues/document-extraction.queue";
import HttpError from "../src/utils/http-error";
import { CONSENT_VERSIONS } from "../src/constants/consent.constants";
import { CLIENT_TERMS_VERSION, TERMS_VERSION } from "../src/constants/auth.constants";

type Row = {
  purpose: ConsentPurpose;
  version: string;
  grantedAt: Date;
  withdrawnAt: Date | null;
};

describe("ConsentSvc", () => {
  const original = {
    findByUser: ConsentRepo.findByUser,
    findTerms: ConsentRepo.findTerms,
    set: ConsentRepo.set,
    find: ConsentRepo.find,
    findRole: ConsentRepo.findRole,
    findPendingDocumentIds: ConsentRepo.findPendingDocumentIds,
    enqueueMany: DocumentExtractionQueue.enqueueMany,
  };
  let rows: Row[];
  let role: string | null;
  let pending: string[];
  let queued: string[][];
  let terms: { termsAcceptedAt: Date | null; termsVersion: string | null; role?: string } | null;
  let sets: Array<{ purpose: ConsentPurpose; granted: boolean; version: string; source: string }>;

  beforeEach(() => {
    rows = [];
    terms = { termsAcceptedAt: null, termsVersion: null };
    sets = [];
    role = "LAWYER";
    pending = [];
    queued = [];
    ConsentRepo.find = (async (_u: string, purpose: ConsentPurpose) => rows.find((r) => r.purpose === purpose) ?? null) as unknown as typeof ConsentRepo.find;
    ConsentRepo.findRole = (async () => role) as unknown as typeof ConsentRepo.findRole;
    ConsentRepo.findPendingDocumentIds = async () => pending;
    DocumentExtractionQueue.enqueueMany = (ids: string[]) => void queued.push(ids);
    ConsentRepo.findByUser = (async () => rows) as unknown as typeof ConsentRepo.findByUser;
    ConsentRepo.findTerms = (async () => terms) as unknown as typeof ConsentRepo.findTerms;
    ConsentRepo.set = (async (_u: string, purpose: ConsentPurpose, granted: boolean, version: string, source: string) => {
      sets.push({ purpose, granted, version, source });
      rows = rows.filter((r) => r.purpose !== purpose);
      const now = new Date("2026-10-08T00:00:00Z");
      rows.push({ purpose, version, grantedAt: now, withdrawnAt: granted ? null : now });
      return {} as never;
    }) as unknown as typeof ConsentRepo.set;
  });
  afterEach(() => {
    ConsentRepo.findByUser = original.findByUser;
    ConsentRepo.findTerms = original.findTerms;
    ConsentRepo.set = original.set;
    ConsentRepo.find = original.find;
    ConsentRepo.findRole = original.findRole;
    ConsentRepo.findPendingDocumentIds = original.findPendingDocumentIds;
    DocumentExtractionQueue.enqueueMany = original.enqueueMany;
  });

  it("lists the purposes the product uses (not analytics or marketing, which it does not), and a purpose never answered is not_set rather than withdrawn", async () => {
    const list = await ConsentSvc.list("u1");
    expect(list.map((c) => c.purpose)).to.deep.equal(["TERMS_OF_SERVICE", "AI_PROCESSING", "SENSITIVE_INFO", "EMAIL_IMPORT"]);
    expect(list.every((c) => c.status === "not_set" && c.version === null)).to.equal(true);
  });

  it("reports Terms of Service from the user row, flagging an older version as outdated", async () => {
    terms = { termsAcceptedAt: new Date("2026-01-01T00:00:00Z"), termsVersion: "2025-01" };
    const tos = (await ConsentSvc.list("u1")).find((c) => c.purpose === "TERMS_OF_SERVICE")!;
    expect(tos).to.deep.include({ status: "granted", version: "2025-01", outdated: true });

    terms = { termsAcceptedAt: new Date("2026-10-01T00:00:00Z"), termsVersion: CONSENT_VERSIONS.TERMS_OF_SERVICE! };
    const current = (await ConsentSvc.list("u1")).find((c) => c.purpose === "TERMS_OF_SERVICE")!;
    expect(current.outdated).to.equal(false);
  });

  it("checks a client account against the client app's own Terms version, not the lawyer one", async () => {
    terms = { termsAcceptedAt: new Date("2026-10-01T00:00:00Z"), termsVersion: CLIENT_TERMS_VERSION, role: "USER" };
    const client = (await ConsentSvc.list("u1")).find((c) => c.purpose === "TERMS_OF_SERVICE")!;
    expect(client).to.deep.include({ version: CLIENT_TERMS_VERSION, outdated: false });

    terms = { termsAcceptedAt: new Date("2026-10-01T00:00:00Z"), termsVersion: TERMS_VERSION, role: "USER" };
    const lawyerTerms = (await ConsentSvc.list("u1")).find((c) => c.purpose === "TERMS_OF_SERVICE")!;
    expect(lawyerTerms.outdated).to.equal(true);
  });

  it("grants a purpose at the current version and records where it came from", async () => {
    const list = await ConsentSvc.set("u1", "AI_PROCESSING", true);
    expect(sets).to.deep.equal([{ purpose: "AI_PROCESSING", granted: true, version: CONSENT_VERSIONS.AI_PROCESSING!, source: "settings" }]);
    expect(list.find((c) => c.purpose === "AI_PROCESSING")).to.deep.include({ status: "granted", withdrawnAt: null });
  });

  it("writes each change to the security audit log, since the table keeps only the latest answer", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const original = SecurityAuditSvc.record;
    SecurityAuditSvc.record = (async (input: Record<string, unknown>) => {
      recorded.push(input);
    }) as unknown as typeof SecurityAuditSvc.record;
    try {
      await ConsentSvc.set("u1", "AI_PROCESSING", true, "first_login");
      await ConsentSvc.set("u1", "AI_PROCESSING", false);
    } finally {
      SecurityAuditSvc.record = original;
    }
    expect(recorded.map((r) => [r.action, r.actorId, r.targetId, (r.payload as { granted: boolean }).granted, (r.payload as { source: string }).source])).to.deep.equal([
      ["consent.changed", "u1", "u1", true, "first_login"],
      ["consent.changed", "u1", "u1", false, "settings"],
    ]);
  });

  it("withdraws a purpose and keeps when it was first granted", async () => {
    rows = [{ purpose: "AI_PROCESSING", version: CONSENT_VERSIONS.AI_PROCESSING!, grantedAt: new Date("2026-09-01T00:00:00Z"), withdrawnAt: null }];
    const list = await ConsentSvc.set("u1", "AI_PROCESSING", false);
    const ai = list.find((c) => c.purpose === "AI_PROCESSING")!;
    expect(ai.status).to.equal("withdrawn");
    expect(ai.grantedAt).to.be.instanceOf(Date);
    expect(ai.outdated).to.equal(false);
  });

  it("flags a granted answer given to an older text as outdated", async () => {
    rows = [{ purpose: "AI_PROCESSING", version: "2025-01", grantedAt: new Date("2025-01-01T00:00:00Z"), withdrawnAt: null }];
    const ai = (await ConsentSvc.list("u1")).find((c) => c.purpose === "AI_PROCESSING")!;
    expect(ai).to.deep.include({ status: "granted", outdated: true });
  });

  describe("email import (#989)", () => {
    const realDisconnect = GmailConnectionSvc.disconnectIfConnected;
    let disconnected: string[];
    beforeEach(() => {
      disconnected = [];
      GmailConnectionSvc.disconnectIfConnected = (async (userId: string) => {
        disconnected.push(userId);
      }) as typeof GmailConnectionSvc.disconnectIfConnected;
    });
    afterEach(() => {
      GmailConnectionSvc.disconnectIfConnected = realDisconnect;
    });

    it("is granted from the Gmail connect step at the current version, without touching the connection", async () => {
      await ConsentSvc.set("u1", "EMAIL_IMPORT", true, "gmail");
      expect(sets).to.deep.equal([{ purpose: "EMAIL_IMPORT", granted: true, version: CONSENT_VERSIONS.EMAIL_IMPORT!, source: "gmail" }]);
      expect(disconnected).to.deep.equal([]);
    });

    it("disconnects Gmail when withdrawn, so withdrawing stops all reading at once", async () => {
      const list = await ConsentSvc.set("u1", "EMAIL_IMPORT", false);
      expect(disconnected).to.deep.equal(["u1"]);
      expect(list.find((c) => c.purpose === "EMAIL_IMPORT")!.status).to.equal("withdrawn");
    });

    it("never disconnects Gmail for a change to another purpose", async () => {
      await ConsentSvc.set("u1", "AI_PROCESSING", false);
      expect(disconnected).to.deep.equal([]);
    });
  });

  it("refuses to change a purpose the product does not use", async () => {
    let status = 0;
    try {
      await ConsentSvc.set("u1", "MARKETING", true);
    } catch (err) {
      status = (err as { statusCode?: number }).statusCode ?? 0;
    }
    expect(status).to.equal(400);
    expect(sets).to.have.length(0);
  });

  it("refuses to change Terms of Service here", async () => {
    let status = 0;
    try {
      await ConsentSvc.set("u1", "TERMS_OF_SERVICE", false);
    } catch (err) {
      status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 0;
    }
    expect(status).to.equal(400);
    expect(sets).to.have.length(0);
  });

  describe("whether the AI may read a case (sensitive information, #699)", () => {
    const grant = (purpose: ConsentPurpose, withdrawn = false) =>
      rows.push({ purpose, version: "v", grantedAt: new Date(), withdrawnAt: withdrawn ? new Date() : null });
    const refusal = async (userId: string) => {
      try {
        await ConsentSvc.assertMayRunAi(userId);
      } catch (err) {
        return err as HttpError;
      }
      return undefined;
    };

    it("asks a client to agree to sensitive information first, and names that purpose in the refusal", async () => {
      role = "USER";
      expect(await ConsentSvc.mayRunAi("c1")).to.equal(false);
      const err = await refusal("c1");
      expect(err?.statusCode).to.equal(403);
      expect(err?.code).to.equal("CONSENT_REQUIRED");
      expect(err?.details).to.deep.equal({ purpose: "SENSITIVE_INFO" });
      grant("SENSITIVE_INFO");
      expect(await ConsentSvc.mayRunAi("c1")).to.equal(true);
    });

    it("never asks a lawyer account, whose AI keeps working as before", async () => {
      role = "LAWYER";
      expect(await ConsentSvc.mayRunAi("l1")).to.equal(true);
    });

    it("blocks everyone who switched AI processing off, even with sensitive information agreed", async () => {
      role = "USER";
      grant("SENSITIVE_INFO");
      grant("AI_PROCESSING", true);
      expect(await ConsentSvc.mayRunAi("c1")).to.equal(false);
      expect((await refusal("c1"))?.code).to.equal("CONSENT_REQUIRED");
    });

    it("is answered and withdrawn from the case step and settings at the current version", async () => {
      role = "USER";
      await ConsentSvc.set("c1", "SENSITIVE_INFO", true, "case_step");
      expect(sets[0]).to.deep.equal({ purpose: "SENSITIVE_INFO", granted: true, version: CONSENT_VERSIONS.SENSITIVE_INFO, source: "case_step" });
      await ConsentSvc.set("c1", "SENSITIVE_INFO", false);
      expect(await ConsentSvc.mayRunAi("c1")).to.equal(false);
    });

    it("indexes the documents held back while the client hadn't agreed, once they do", async () => {
      role = "USER";
      pending = ["d1", "d2"];
      await ConsentSvc.set("c1", "SENSITIVE_INFO", true, "case_step");
      expect(queued).to.deep.equal([["d1", "d2"]]);
    });

    it("keeps them held when the AI still can't read the case", async () => {
      role = "USER";
      pending = ["d1"];
      grant("AI_PROCESSING", true);
      await ConsentSvc.set("c1", "SENSITIVE_INFO", true, "case_step");
      expect(queued).to.deep.equal([]);
    });
  });
});
