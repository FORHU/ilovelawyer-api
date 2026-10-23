import { ClientSide, OrganizationRole, Prisma } from "@prisma/client";
import ClientCaseRepo, { type ClientCaseRow } from "../repositories/client-case.repository";
import ClientPaymentRepo from "../repositories/client-payment.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import ClientBillingSvc from "./client-billing.service";
import CaseSvc from "./case.service";
import ChatSvc from "./chat.service";
import DocumentSvc from "./document.service";
import OrganizationSvc from "./organization.service";
import HttpError from "../utils/http-error";
import { emitToUser } from "../lib/socket";
import { CLIENT_HANDOFF_SOCKET_EVENTS, type EngagementDocumentAddedEvent } from "../types/client-handoff";
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
import type { ClientCaseArea } from "../constants/client-case.constants";
import { firmScope } from "../utils/workspace";

/** The client's personal workspace, as req.organization carries it. */
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
}

/** A Consultation title is VarChar(80). */
const CONSULTATION_TITLE_MAX = 80;

function toDto(row: ClientCaseRow) {
  return {
    id: row.id,
    title: row.caseName,
    area: (row.practiceArea ?? "OTHER") as ClientCaseArea,
    ukJurisdiction: row.ukJurisdiction,
    where: row.jurisdiction ?? "",
    side: row.clientSide,
    others: row.parties.map((p) => ({ id: p.id, name: p.name, role: p.designation })),
    documents: row.documents.map((d) => ({ id: d.id, name: d.name, status: d.ragStatus, createdAt: d.createdAt })),
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

  static async list(workspace: ClientWorkspace) {
    return (await ClientCaseRepo.list(workspace.id)).map(toDto);
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
      });
    } catch (err) {
      await ClientPaymentRepo.releaseCasePayment(input.paymentId);
      throw err;
    }
    await ClientPaymentRepo.attachToCase(input.paymentId, created.id, credits);
    await ChatSvc.createConsultation(firmScope(workspace.id), userId, input.title.slice(0, CONSULTATION_TITLE_MAX), created.id);
    return ClientCaseSvc.get(workspace, created.id);
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
        createdAt: m.createdAt,
      })),
    };
  }

  /** Asks the AI, for one chat credit. The answer is generated in the background
   * (ChatGenerationQueue) and shows up in listMessages. A message that couldn't be queued gets its
   * credit back; one the AI then fails to answer keeps it spent, like any other AI work. */
  static async sendMessage(workspace: ClientWorkspace, userId: string, caseId: string, text: string) {
    const consultationId = await ClientCaseSvc.consultationOf(workspace, userId, caseId);
    await ClientBillingSvc.spendCredit(caseId);
    try {
      return await ChatSvc.enqueueChatGeneration(firmScope(workspace.id), workspace.tenantCode, userId, consultationId, "", text, undefined, undefined, caseId);
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
    return { id: doc.id, name: doc.name, status: doc.ragStatus, createdAt: doc.createdAt };
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
