import { ClientRequestStatus, ClientSide, OrganizationRole, Prisma, RagStatus } from "@prisma/client";
import ClientCaseRepo, { type ClientCaseRow } from "../repositories/client-case.repository";
import type { CaseData } from "../repositories/case.repository";
import ClientPaymentRepo from "../repositories/client-payment.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import DocumentRepo from "../repositories/document.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import ClientBillingSvc from "./client-billing.service";
import CaseSvc from "./case.service";
import ChatSvc from "./chat.service";
import ClientRequestSvc from "./client-request.service";
import DocumentSvc, { documentFileUrl } from "./document.service";
import OrganizationSvc from "./organization.service";
import HttpError from "../utils/http-error";
import { emitToUser } from "../lib/socket";
import { CLIENT_HANDOFF_SOCKET_EVENTS, type EngagementDocumentAddedEvent, type EngagementDocumentRemovedEvent } from "../types/client-handoff";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import { JevUnavailableError } from "../utils/typesafeClient";
import {
  READINESS_CRITERIA,
  READINESS_MIN_CONFIDENCE,
  assessLawyerReadiness,
  isLawyerReadinessJevEnabled,
  type ReadinessAssessment,
} from "../utils/lawyer-readiness-jev";
import logger from "../utils/logger";
import { CLIENT_TENANT_CODE } from "../constants/auth.constants";
import { CLIENT_DOCUMENT_LINK_SECONDS, type ClientCaseArea } from "../constants/client-case.constants";
import { firmScope } from "../utils/workspace";

/** The client's personal workspace, as clientWorkspaceOf(req) gives it. */
export interface ClientWorkspace {
  id: string;
  role: OrganizationRole;
  tenantCode: TenantCode;
}

export interface NewClientCase {
  /** A successful, unused case payment of this client's (ClientBillingSvc.payForCase). */
  paymentId: string;
  title: string;
  area: ClientCaseArea;
  /** Null when the client said it happened outside the UK. */
  ukJurisdiction: string | null;
  where?: string;
  side?: ClientSide | null;
  others?: { name: string; role: string }[];
  /** What happened and what the client wants, as one block of text. */
  notes?: string;
}

/** What the client may change on a case they've made. Anything left out stays as it is. */
export interface ClientCaseChanges {
  title?: string;
  area?: ClientCaseArea;
  ukJurisdiction?: string | null;
  where?: string;
  side?: ClientSide | null;
  others?: { name: string; role: string }[];
  notes?: string;
}

/** Once a lawyer holds the request, their conflict check and quote rest on the case's problem, place
 * and people, so those stop being editable. CONFIRMED and ENGAGED also stop the case being removed. */
const LAWYER_HELD: ClientRequestStatus[] = ["CLAIMED", "QUOTED", "CONFIRMED", "ENGAGED"];
const LAWYER_COMMITTED: ClientRequestStatus[] = ["CONFIRMED", "ENGAGED"];

/** A Consultation title is VarChar(80). */
const CONSULTATION_TITLE_MAX = 80;

/** A document as the client app lists it. A Document has no upload time of its own: it's made when
 * the upload is confirmed, so createdAt is when it was uploaded. createdAt stays for older apps. */
function toDocumentDto(d: { id: string; name: string; ragStatus: RagStatus; fileSize: number | null; createdAt: Date }) {
  return { id: d.id, name: d.name, status: d.ragStatus, size: d.fileSize ?? null, uploadedAt: d.createdAt, createdAt: d.createdAt };
}

function toDto(row: ClientCaseRow) {
  return {
    id: row.id,
    title: row.caseName,
    area: (row.practiceArea ?? "OTHER") as ClientCaseArea,
    ukJurisdiction: row.ukJurisdiction,
    where: row.jurisdiction ?? "",
    notes: row.notes ?? "",
    side: row.clientSide,
    others: row.parties.map((p) => ({ id: p.id, name: p.name, role: p.designation })),
    documents: row.documents.map(toDocumentDto),
    credits: row.clientCredits,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type ClientCaseDto = ReturnType<typeof toDto>;

/** Why a lawyer can't be suggested even with everything known. */
type ReadinessBlock = "OUTSIDE_UK" | "PERSONAL_INJURY";

/** What the client app shows: whether to suggest a lawyer, and what's known and missing. */
export interface LawyerReadiness {
  /** False when USE_JEV_LAWYER_READINESS is off: the app then offers a lawyer as before. */
  enabled: boolean;
  ready: boolean;
  criteria: ReadinessAssessment["criteria"];
  /** The kind of lawyer the case needs, once Jev has looked. */
  practiceArea: ReadinessAssessment["practiceArea"] | null;
  ukJurisdiction: string | null;
  blockedBy: ReadinessBlock | null;
  /** Jev couldn't be reached this time; nothing is claimed either way. */
  unavailable: boolean;
  checkedAt: string | null;
  /** The AI answer this check read up to. A newer answer means a fresh check. */
  basedOnMessageId: string | null;
}

/** Whether two lists name the same people in the same roles, in any order. */
function samePeople(next: { name: string; role: string }[], current: { name: string; designation: string }[]) {
  const key = (name: string, role: string) => `${name.trim().toLowerCase()}|${role}`;
  const a = next.map((p) => key(p.name, p.role)).sort();
  const b = current.map((p) => key(p.name, p.designation)).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** "A.pdf", "A.pdf and B.pdf", "A.pdf, B.pdf and C.pdf" */
function listNames(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

/** What the app shows when a message's documents aren't all READY. */
function notReadyMessage(docs: { name: string; ragStatus: string }[]) {
  const reading = docs.filter((d) => d.ragStatus === "PENDING").map((d) => d.name);
  const failed = docs.filter((d) => d.ragStatus === "FAILED").map((d) => d.name);
  const sentences: string[] = [];
  if (reading.length) sentences.push(`Still reading ${listNames(reading)}. Send again once ${reading.length > 1 ? "they're" : "it's"} ready.`);
  if (failed.length) {
    const them = failed.length > 1 ? "them" : "it";
    sentences.push(`We couldn't read ${listNames(failed)}. Upload ${them} again to use ${them}.`);
  }
  return sentences.join(" ");
}

function unchecked(ukJurisdiction: string | null, unavailable = false): LawyerReadiness {
  return {
    enabled: true,
    ready: false,
    criteria: READINESS_CRITERIA.map((c) => ({ key: c.key, label: c.label, met: false, confidence: 0 })),
    practiceArea: null,
    ukJurisdiction,
    blockedBy: null,
    unavailable,
    checkedAt: null,
    basedOnMessageId: null,
  };
}

/**
 * The client app's cases (ilovelawyer-client, USER accounts). A client's case is an ordinary Case
 * in their personal workspace on the client tenant, with one Consultation that the chat runs in,
 * so the AI, document extraction and access rules are the same ones lawyers use. This is a thin,
 * client-shaped layer over CaseSvc, ChatSvc and DocumentSvc. Its own rules: only your own cases,
 * a case is paid for before it's made, and each message to the AI takes a chat credit
 * (ClientBillingSvc).
 */
export default class ClientCaseSvc {
  /** The workspace every client request runs in, made the first time it's needed. A client never
   * joins an organization, so anything else means the account isn't a plain client. */
  static async workspaceFor(userId: string, name: string): Promise<ClientWorkspace> {
    let member = await OrganizationMemberRepo.findAnyForUser(userId);
    if (!member) {
      try {
        await OrganizationSvc.create(userId, name, undefined, CLIENT_TENANT_CODE, true);
      } catch (err) {
        // Two first requests at once: the other one made it (OrganizationMember.userId is unique).
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      }
      member = await OrganizationMemberRepo.findAnyForUser(userId);
    }
    if (!member || !member.organization.isPersonal || member.status !== "ACCEPTED") {
      throw new HttpError("This account isn't set up as a client account", 409, "NOT_A_CLIENT_WORKSPACE");
    }
    return { id: member.organizationId, role: member.role, tenantCode: asTenantCode(member.organization.tenant.code) };
  }

  static async list(workspace: ClientWorkspace, archived = false) {
    return (await ClientCaseRepo.list(workspace.id, archived ? "ARCHIVED" : "ACTIVE")).map(toDto);
  }

  static async get(workspace: ClientWorkspace, caseId: string) {
    return toDto(await ClientCaseSvc.load(workspace, caseId));
  }

  /** Uses up the case payment first, so one payment can't make two cases, and gives it back if the
   * case then can't be made, so the client can retry without paying again. */
  static async create(workspace: ClientWorkspace, userId: string, input: NewClientCase) {
    const credits = await ClientPaymentRepo.claimCasePayment(input.paymentId, userId);
    if (credits === null) throw new HttpError("Pay for the case first.", 402, "PAYMENT_REQUIRED");
    let created: { id: string };
    try {
      created = await CaseSvc.create(firmScope(workspace.id), userId, workspace.role, {
        caseName: input.title,
        practiceArea: input.area,
        ukJurisdiction: input.ukJurisdiction ?? undefined,
        jurisdiction: input.where || undefined,
        clientSide: input.side ?? null,
        parties: (input.others ?? []).map((o) => ({ name: o.name, designation: o.role })),
        ...(input.notes ? { notes: input.notes } : {}),
      });
    } catch (err) {
      await ClientPaymentRepo.releaseCasePayment(input.paymentId);
      throw err;
    }
    await ClientPaymentRepo.attachToCase(input.paymentId, created.id, credits);
    await ChatSvc.createConsultation(firmScope(workspace.id), userId, input.title.slice(0, CONSULTATION_TITLE_MAX), created.id);
    return ClientCaseSvc.get(workspace, created.id);
  }

  /**
   * Changes a case's details. The lawyer-request brief rewrites itself when it next reads the case
   * (its fingerprint covers these fields), but the stored readiness check is keyed by the last AI
   * answer, so it's cleared here to be asked again. While a lawyer holds the request the problem,
   * the place and the people are fixed (409 CASE_LOCKED_BY_REQUEST), and a case can't move outside
   * the UK while any request is open, since a lawyer can't be asked for one.
   */
  static async update(workspace: ClientWorkspace, userId: string, caseId: string, input: ClientCaseChanges) {
    const row = await ClientCaseSvc.load(workspace, caseId);
    const live = await ClientRequestRepo.findLiveForCase(caseId);
    if (live) {
      const held = LAWYER_HELD.includes(live.status);
      const movesOutsideUk = input.ukJurisdiction === null && row.ukJurisdiction !== null;
      const changesFixed =
        (input.area !== undefined && input.area !== row.practiceArea) ||
        (input.ukJurisdiction !== undefined && input.ukJurisdiction !== row.ukJurisdiction) ||
        (input.others !== undefined && !samePeople(input.others, row.parties));
      if ((held && changesFixed) || movesOutsideUk) {
        throw new HttpError(
          movesOutsideUk && !held
            ? "Withdraw your lawyer request before moving this case outside the UK."
            : "A lawyer is working on your request, so the type of issue, the part of the UK and the people involved can't change now.",
          409,
          "CASE_LOCKED_BY_REQUEST",
          { status: live.status },
        );
      }
    }

    const data: CaseData = {};
    if (input.title !== undefined) data.caseName = input.title;
    if (input.area !== undefined) data.practiceArea = input.area;
    if (input.ukJurisdiction !== undefined) data.ukJurisdiction = input.ukJurisdiction;
    if (input.where !== undefined) data.jurisdiction = input.where || null;
    if (input.side !== undefined) data.clientSide = input.side;
    if (input.notes !== undefined) data.notes = input.notes || null;
    if (input.others !== undefined) data.parties = input.others.map((o) => ({ name: o.name, designation: o.role }));

    await CaseSvc.update(caseId, firmScope(workspace.id), userId, data);
    await ClientCaseRepo.clearReadiness(caseId);
    return ClientCaseSvc.get(workspace, caseId);
  }

  /** Sets the case aside. Out of the client's list, restorable. */
  static async archive(workspace: ClientWorkspace, userId: string, caseId: string) {
    await ClientCaseSvc.load(workspace, caseId);
    await ClientCaseSvc.stepAsideRequest(userId, caseId);
    await CaseSvc.archive(caseId, firmScope(workspace.id), userId);
  }

  static async unarchive(workspace: ClientWorkspace, userId: string, caseId: string) {
    const row = await ClientCaseRepo.findAnyById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    await CaseSvc.unarchive(caseId, firmScope(workspace.id), userId);
    return ClientCaseSvc.get(workspace, caseId);
  }

  /** Deletes the case with its chat, documents and any lawyer request on it. Payments are kept (the
   * payment row only loses its link to the case), and credits aren't refunded. */
  static async remove(workspace: ClientWorkspace, userId: string, caseId: string) {
    const row = await ClientCaseRepo.findAnyById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    await ClientCaseSvc.stepAsideRequest(userId, caseId);
    await CaseSvc.delete(caseId, firmScope(workspace.id), userId);
  }

  /** Before the case goes away or is set aside: an open request nobody has committed to is withdrawn
   * (a lawyer holding it is told); one with a confirmed or engaged lawyer blocks it, because the
   * request, its fee and the lawyer's access all hang off the case. */
  private static async stepAsideRequest(clientId: string, caseId: string) {
    const live = await ClientRequestRepo.findLiveForCase(caseId);
    if (!live) return;
    if (LAWYER_COMMITTED.includes(live.status)) {
      throw new HttpError(
        "A lawyer is engaged on this case, or being confirmed. End the engagement first, then you can remove the case.",
        409,
        "CASE_HAS_ACTIVE_ENGAGEMENT",
        { requestId: live.id, status: live.status },
      );
    }
    await ClientRequestSvc.withdraw(clientId, live.id);
  }

  /** The chat, oldest first. `replying` is true while the AI is still answering the last message,
   * so the app knows to keep checking. */
  static async listMessages(workspace: ClientWorkspace, userId: string, caseId: string) {
    const consultationId = await ClientCaseSvc.consultationOf(workspace, userId, caseId);
    const messages = await ChatSvc.listMessages(firmScope(workspace.id), userId, consultationId);
    const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");
    return {
      replying: visible.some((m) => m.role === "user" && m.replyStatus === "PENDING"),
      messages: visible.map((m) => ({
        id: m.id,
        role: m.role === "user" ? ("user" as const) : ("ai" as const),
        text: m.content,
        /** User messages only: whether the AI's answer to it arrived. */
        replyStatus: m.role === "user" ? m.replyStatus : null,
        /** The case documents sent with a user message (sendMessage's documentIds). */
        documents: m.role === "user" ? m.documents.map((d) => ({ id: d.id, name: d.name, status: d.ragStatus })) : [],
        createdAt: m.createdAt,
      })),
    };
  }

  /** Asks the AI, for one chat credit. The answer is generated in the background
   * (ChatGenerationQueue) and shows up in listMessages. A message that couldn't be queued gets its
   * credit back; one the AI then fails to answer keeps it spent, like any other AI work.
   * `documentIds` are the case's documents sent with it, each READY (checked before the credit is
   * spent, so a refused send costs nothing). */
  static async sendMessage(workspace: ClientWorkspace, userId: string, caseId: string, text: string, documentIds: string[] = []) {
    const consultationId = await ClientCaseSvc.consultationOf(workspace, userId, caseId);
    const ids = [...new Set(documentIds)];
    if (ids.length) await ClientCaseSvc.assertAttachable(workspace, caseId, ids);
    await ClientBillingSvc.spendCredit(caseId);
    try {
      return await ChatSvc.enqueueChatGeneration(
        firmScope(workspace.id),
        workspace.tenantCode,
        userId,
        consultationId,
        "",
        text,
        undefined,
        undefined,
        caseId,
        ids.length ? ids : undefined,
      );
    } catch (err) {
      await ClientBillingSvc.refundCredit(caseId);
      throw err;
    }
  }

  /**
   * Whether the case has enough in it to suggest a lawyer, checked by Jev against the case details
   * and the chat (lawyer-readiness-jev.ts). Checked once per AI answer and stored on the case, so
   * reading it again costs nothing. Ready means every point is covered, the case is in the UK, and
   * it isn't personal injury. When Jev can't be reached the answer is "unavailable", never "ready".
   */
  static async lawyerReadiness(workspace: ClientWorkspace, userId: string, caseId: string): Promise<LawyerReadiness> {
    if (!isLawyerReadinessJevEnabled()) return { ...unchecked(null), enabled: false };
    const row = await ClientCaseSvc.load(workspace, caseId);
    const { messages } = await ClientCaseSvc.listMessages(workspace, userId, caseId);
    const latestAnswer = [...messages].reverse().find((m) => m.role === "ai");
    if (!latestAnswer) return unchecked(row.ukJurisdiction);

    const cached = row.lawyerReadiness as unknown as LawyerReadiness | null;
    if (cached?.basedOnMessageId === latestAnswer.id) return cached;

    let assessment: ReadinessAssessment;
    try {
      assessment = await assessLawyerReadiness({
        caseDetails: {
          title: row.caseName,
          area: row.practiceArea,
          ukJurisdiction: row.ukJurisdiction,
          where: row.jurisdiction,
          side: row.clientSide,
          otherParties: row.parties.map((p) => `${p.name} (${p.designation})`),
          notes: row.notes,
        },
        conversation: messages.map((m) => ({ from: m.role === "user" ? "client" : "ai", text: m.text })),
      });
    } catch (err) {
      if (!(err instanceof JevUnavailableError)) throw err;
      logger.warn("Lawyer readiness: Jev unavailable", { caseId, reason: err.reason });
      return unchecked(row.ukJurisdiction, true);
    }

    const personalInjury = assessment.practiceArea.value === "PERSONAL_INJURY" && assessment.practiceArea.confidence >= READINESS_MIN_CONFIDENCE;
    const blockedBy: ReadinessBlock | null = !row.ukJurisdiction ? "OUTSIDE_UK" : personalInjury ? "PERSONAL_INJURY" : null;
    const ready = !blockedBy && assessment.criteria.every((c) => c.met);
    const result: LawyerReadiness = {
      enabled: true,
      ready,
      criteria: assessment.criteria,
      practiceArea: assessment.practiceArea,
      ukJurisdiction: row.ukJurisdiction,
      blockedBy,
      unavailable: false,
      checkedAt: new Date().toISOString(),
      basedOnMessageId: latestAnswer.id,
    };
    // Once the case is ready, Jev's area is the one matching uses, even if the client picked another.
    const settledArea = ready && assessment.practiceArea.value !== "PERSONAL_INJURY" ? assessment.practiceArea.value : undefined;
    await ClientCaseRepo.saveReadiness(caseId, result as unknown as Prisma.InputJsonValue, settledArea);
    return result;
  }

  static async topUp(workspace: ClientWorkspace, userId: string, caseId: string, input: { packId: string; testOutcome?: "decline"; origin?: string }) {
    await ClientCaseSvc.load(workspace, caseId);
    return ClientBillingSvc.topUp(userId, caseId, input);
  }

  /** Step one of an upload: a URL the browser PUTs the file to, straight to S3. */
  static async presignDocument(workspace: ClientWorkspace, userId: string, caseId: string, file: { filename: string; contentType: string; fileSize?: number }) {
    await ClientCaseSvc.load(workspace, caseId);
    return DocumentSvc.presign(firmScope(workspace.id), userId, file.filename, file.contentType, caseId, undefined, file.fileSize);
  }

  /** Step two: records the uploaded file on the case. Extraction starts from here, and the AI uses
   * the document once it's READY. */
  static async addDocument(workspace: ClientWorkspace, userId: string, caseId: string, file: { key: string; name: string; contentType?: string; fileSize?: number }) {
    await ClientCaseSvc.load(workspace, caseId);
    const doc = await DocumentSvc.create(firmScope(workspace.id), userId, { ...file, caseId });
    const engaged = await ClientRequestRepo.findEngagedLawyerForCase(caseId);
    if (engaged) {
      const event: EngagementDocumentAddedEvent = {
        requestId: engaged.requestId,
        caseId,
        documentId: doc.id,
        filename: doc.name,
        submittedBy: engaged.client,
        submittedAt: doc.createdAt.toISOString(),
      };
      emitToUser(engaged.lawyerId, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_DOCUMENT_ADDED, event);
    }
    return toDocumentDto(doc);
  }

  /** Takes a document off the case for good, its file and timeline links with it. The overview
   * reads STALE from then on if the document was READY (its READY-set fingerprint changes). */
  static async removeDocument(workspace: ClientWorkspace, userId: string, caseId: string, documentId: string) {
    const doc = await ClientCaseSvc.loadDocument(workspace, caseId, documentId);
    await DocumentSvc.delete(doc.id, firmScope(workspace.id), userId);
    const engaged = await ClientRequestRepo.findEngagedLawyerForCase(caseId);
    if (engaged) {
      const event: EngagementDocumentRemovedEvent = { requestId: engaged.requestId, caseId, documentId: doc.id, filename: doc.name };
      emitToUser(engaged.lawyerId, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_DOCUMENT_REMOVED, event);
    }
  }

  /** A link that opens the document in the browser, good for CLIENT_DOCUMENT_LINK_SECONDS. */
  static async documentUrl(workspace: ClientWorkspace, caseId: string, documentId: string) {
    const doc = await ClientCaseSvc.loadDocument(workspace, caseId, documentId);
    if (!doc.file?.s3Key) throw new HttpError("Document has no file", 404);
    const url = documentFileUrl(doc.file.s3Key, doc.name, { id: doc.id, caseId }, CLIENT_DOCUMENT_LINK_SECONDS);
    return { url, expiresAt: new Date(Date.now() + CLIENT_DOCUMENT_LINK_SECONDS * 1000) };
  }

  /** Reads a document that couldn't be read again, now rather than at the next sweep. Only a FAILED
   * one: a PENDING one is already queued, and a READY one has nothing to retry. */
  static async retryDocument(workspace: ClientWorkspace, caseId: string, documentId: string) {
    const doc = await ClientCaseSvc.loadDocument(workspace, caseId, documentId);
    if (doc.ragStatus !== "FAILED") throw new HttpError("Only a document that couldn't be read can be tried again", 409, "NOT_FAILED");
    await DocumentRepo.updateRagStatus(doc.id, "PENDING");
    DocumentExtractionQueue.enqueue(doc.id);
    return toDocumentDto({ ...doc, ragStatus: "PENDING" });
  }

  /** The case first (404 for another client's), then the document on it (404, never saying whose). */
  private static async loadDocument(workspace: ClientWorkspace, caseId: string, documentId: string) {
    await ClientCaseSvc.load(workspace, caseId);
    const doc = await DocumentRepo.findOneForCase(documentId, caseId, firmScope(workspace.id));
    if (!doc) throw new HttpError("Document not found", 404);
    return doc;
  }

  /** Every id must be an active document on this case (404 otherwise, never saying whose it is),
   * and READY, so the AI never answers before it has read what was sent (409, naming the rest). */
  private static async assertAttachable(workspace: ClientWorkspace, caseId: string, ids: string[]) {
    const docs = await DocumentRepo.findManyForCase(ids, caseId, firmScope(workspace.id));
    if (docs.length !== ids.length) throw new HttpError("Document not found", 404);
    const notReady = docs.filter((d) => d.ragStatus !== "READY");
    if (notReady.length) {
      throw new HttpError(notReadyMessage(notReady), 409, "DOCUMENTS_NOT_READY", {
        documents: notReady.map((d) => ({ id: d.id, name: d.name, status: d.ragStatus })),
      });
    }
  }

  private static async load(workspace: ClientWorkspace, caseId: string) {
    const row = await ClientCaseRepo.findById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    return row;
  }

  /** The case's chat. Every client case gets one when it's made; this also covers one that lost it. */
  private static async consultationOf(workspace: ClientWorkspace, userId: string, caseId: string): Promise<string> {
    const row = await ClientCaseSvc.load(workspace, caseId);
    if (row.consultations[0]) return row.consultations[0].id;
    const created = await ChatSvc.createConsultation(firmScope(workspace.id), userId, row.caseName.slice(0, CONSULTATION_TITLE_MAX), caseId);
    return created.id;
  }
}
