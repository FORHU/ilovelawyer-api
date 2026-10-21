import { ClientSide, OrganizationRole, Prisma } from "@prisma/client";
import ClientCaseRepo, { type ClientCaseRow } from "../repositories/client-case.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import CaseSvc from "./case.service";
import ChatSvc from "./chat.service";
import DocumentSvc from "./document.service";
import OrganizationSvc from "./organization.service";
import HttpError from "../utils/http-error";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import { CLIENT_TENANT_CODE } from "../constants/auth.constants";
import type { ClientCaseArea } from "../constants/client-case.constants";

/** The client's personal workspace, as req.organization carries it. */
export interface ClientWorkspace {
  id: string;
  role: OrganizationRole;
  tenantCode: TenantCode;
}

export interface NewClientCase {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type ClientCaseDto = ReturnType<typeof toDto>;

/**
 * The client app's cases (ilovelawyer-client, USER accounts). A client's case is an ordinary Case
 * in their personal workspace on the client tenant, with one Consultation that the chat runs in,
 * so the AI, document extraction and access rules are the same ones lawyers use. This is a thin,
 * client-shaped layer over CaseSvc, ChatSvc and DocumentSvc, and adds no rules of its own beyond
 * "only your own cases".
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

  static async create(workspace: ClientWorkspace, userId: string, input: NewClientCase) {
    const created = await CaseSvc.create(workspace.id, userId, workspace.role, {
      caseName: input.title,
      practiceArea: input.area,
      ukJurisdiction: input.ukJurisdiction ?? undefined,
      jurisdiction: input.where || undefined,
      clientSide: input.side ?? null,
      parties: (input.others ?? []).map((o) => ({ name: o.name, designation: o.role })),
    });
    await ChatSvc.createConsultation(workspace.id, userId, input.title.slice(0, CONSULTATION_TITLE_MAX), created.id);
    return ClientCaseSvc.get(workspace, created.id);
  }

  /** The chat, oldest first. `replying` is true while the AI is still answering the last message,
   * so the app knows to keep checking. */
  static async listMessages(workspace: ClientWorkspace, userId: string, caseId: string) {
    const consultationId = await ClientCaseSvc.consultationOf(workspace, userId, caseId);
    const messages = await ChatSvc.listMessages(workspace.id, userId, consultationId);
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

  /** Asks the AI. The answer is generated in the background (ChatGenerationQueue) and shows up in
   * listMessages. */
  static async sendMessage(workspace: ClientWorkspace, userId: string, caseId: string, text: string) {
    const consultationId = await ClientCaseSvc.consultationOf(workspace, userId, caseId);
    return ChatSvc.enqueueChatGeneration(workspace.id, workspace.tenantCode, userId, consultationId, "", text, undefined, undefined, caseId);
  }

  /** Step one of an upload: a URL the browser PUTs the file to, straight to S3. */
  static async presignDocument(workspace: ClientWorkspace, userId: string, caseId: string, file: { filename: string; contentType: string; fileSize?: number }) {
    await ClientCaseSvc.load(workspace, caseId);
    return DocumentSvc.presign(workspace.id, userId, file.filename, file.contentType, caseId, undefined, file.fileSize);
  }

  /** Step two: records the uploaded file on the case. Extraction starts from here, and the AI uses
   * the document once it's READY. */
  static async addDocument(workspace: ClientWorkspace, userId: string, caseId: string, file: { key: string; name: string; contentType?: string; fileSize?: number }) {
    await ClientCaseSvc.load(workspace, caseId);
    const doc = await DocumentSvc.create(workspace.id, userId, { ...file, caseId });
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
    const created = await ChatSvc.createConsultation(workspace.id, userId, row.caseName.slice(0, CONSULTATION_TITLE_MAX), caseId);
    return created.id;
  }
}
