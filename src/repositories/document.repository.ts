import prisma from "../lib/prisma";
import CaseAccess from "../utils/case-access";
import { Prisma, RagStatus, DocumentStatus } from "@prisma/client";
import CaseRepo from "./case.repository";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewUserDocument {
  organizationId: string;
  userId: string;
  caseId?: string;
  consultationId?: string;
  fileId: string;
  name: string;
  documentType?: string;
  fileSize?: number;
  mimeType?: string;
  category?: string;
}

export default class DocumentRepo {
  /** userId is stamped for "created by" audit purposes only — reads/updates/deletes below scope by organizationId. */
  static async create(
    organizationId: string,
    userId: string,
    data: { name: string; fileId: string; caseId?: string; consultationId?: string; mimeType?: string; fileSize?: number },
  ) {
    const created = await prisma.document.create({ data: { organizationId, userId, ...data }, include: { file: true } });
    CaseRepo.touchSafe(data.caseId);
    return created;
  }

  /** No `include` here — createManyAndReturn only supports including relations under Prisma's
   * relationJoins preview feature, which this project doesn't enable. Callers already have the
   * just-created File rows in scope (same transaction) and merge fileUrl in manually. */
  static async createManyAndReturn(items: NewUserDocument[], client: DbClient = prisma) {
    const created = await client.document.createManyAndReturn({ data: items });
    // Uploading documents is real work on a case — bump its "Last updated" (see CaseRepo.touch).
    for (const caseId of new Set(items.map((item) => item.caseId))) CaseRepo.touchSafe(caseId);
    return created;
  }

  /** Lightweight id/name/category lookup for the case-document manifest sent to chat-wonder-v2-api
   * (see docs/adr/0005 — a document not selected into the model's context still needs to be known
   * to exist). No organizationId scoping: callers already resolve `ids` from an
   * organization-scoped grounding query, so this is a cheap batch fetch, not an access check. */
  static async findManifestByIds(ids: string[]) {
    if (!ids.length) return [];
    return prisma.document.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, category: true },
    });
  }

  /** The organization's documents, minus those on a case `userId` can't open — a confidential
   * case's documents are left out for anyone walled off from it (#346) — and minus files that live
   * only in someone else's standalone Consultation, which is private to its creator, as are its files. */
  static async list(organizationId: string, status: DocumentStatus = "ACTIVE", userId: string) {
    return prisma.document.findMany({
      where: {
        organizationId,
        status,
        OR: [{ caseId: null }, { case: CaseAccess.visibleWhere(userId) }],
        NOT: { caseId: null, consultation: { is: { userId: { not: userId } } } },
      },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  static async listByCase(organizationId: string, caseId: string, status: DocumentStatus = "ACTIVE") {
    return prisma.document.findMany({
      where: { organizationId, caseId, status },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  static async listByConsultation(organizationId: string, consultationId: string, status: DocumentStatus = "ACTIVE") {
    return prisma.document.findMany({
      where: { organizationId, consultationId, status },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  /** (id, name) of every document attached to a consultation and/or a case, any status (an
   * archived document can still be cited by an older answer). Scoped to the organization. Used to
   * turn the file ids an AI answer or Decision Record may carry into names - see
   * utils/document-references.ts. */
  static async listRefsForScope(organizationId: string, scope: { consultationId?: string | null; caseId?: string | null }) {
    const or: Array<{ consultationId: string } | { caseId: string }> = [];
    if (scope.consultationId) or.push({ consultationId: scope.consultationId });
    if (scope.caseId) or.push({ caseId: scope.caseId });
    if (!or.length) return [];
    return prisma.document.findMany({ where: { organizationId, OR: or }, select: { id: true, name: true } });
  }

  /** Unscoped by organizationId — used internally by case-level services (refresh, strategy,
   * snapshot, evidence intelligence) that already resolved case access themselves. */
  /** READY case documents WitnessExtractSvc hasn't read yet, oldest first. */
  static async listPendingWitnessExtraction(caseId: string) {
    return prisma.document.findMany({
      where: { caseId, ragStatus: "READY", witnessesExtractedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
  }

  static async markWitnessesExtracted(ids: string[]) {
    if (!ids.length) return;
    await prisma.document.updateMany({ where: { id: { in: ids } }, data: { witnessesExtractedAt: new Date() } });
  }

  /** Same shape as the witness pair above, for DamagesExtractSvc (Document.damagesExtractedAt). */
  static async listPendingDamagesExtraction(caseId: string) {
    return prisma.document.findMany({
      where: { caseId, ragStatus: "READY", damagesExtractedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, category: true },
    });
  }

  static async markDamagesExtracted(ids: string[]) {
    if (!ids.length) return;
    await prisma.document.updateMany({ where: { id: { in: ids } }, data: { damagesExtractedAt: new Date() } });
  }

  /** "Propose from documents": lets the next damages pass read every document of the case again. */
  static async clearDamagesExtracted(caseId: string) {
    await prisma.document.updateMany({ where: { caseId }, data: { damagesExtractedAt: null } });
  }

  /** Every reader of a case's documents goes through this — the snapshot, findings, refresh, mind
   * map, outlook, reconstruction, graph view, and the case-delete cascade. Scoped to the case's own
   * organization (#373), not just its id: a document can only be read as part of a case when its
   * organizationId matches the case's, so one planted in — or left behind in — another org's case
   * (upload should have refused it, see #371; this is the second line of defence) is never surfaced
   * through it. A case with no organization (legacy/creator-owned, see CaseAccess.ownedByUser) has
   * nothing to match against, so the caseId-only filter stands, same as before this. */
  static async listAllByCase(caseId: string) {
    const organizationId = await CaseRepo.findOrganizationId(caseId);
    return prisma.document.findMany({
      where: { caseId, ...(organizationId ? { organizationId } : {}) },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  /** PENDING/FAILED docs that should be extracted — re-queue after restart. FAILED is included
   * so a 429/OOM does not permanently skip embedding. */
  /** `olderThanMs`, when given, only returns documents whose `createdAt` is that old —
   * used by the periodic sweep (see DocumentExtractionQueue) so it doesn't re-queue a document
   * that's still within a normal first-attempt window (createdAt is upload time, not
   * extraction-attempt time — the model has no separate "attempt started" timestamp). The
   * boot-time reload omits this: at boot nothing could possibly still be legitimately in
   * flight, so every PENDING/FAILED document found there is unambiguously stuck. */
  static async listPendingForExtraction(olderThanMs?: number) {
    return prisma.document.findMany({
      where: {
        ragStatus: { in: ["PENDING", "FAILED"] },
        OR: [{ caseId: { not: null } }, { consultationId: { not: null } }],
        ...(olderThanMs ? { createdAt: { lt: new Date(Date.now() - olderThanMs) } } : {}),
      },
      select: { id: true },
    });
  }

  static async countPendingExtractionByCase(caseId: string) {
    return prisma.document.count({
      where: { caseId, ragStatus: "PENDING" },
    });
  }

  static async countReadyByConsultation(consultationId: string) {
    return prisma.document.count({
      where: { consultationId, ragStatus: "READY" },
    });
  }

  static async findById(id: string, organizationId: string) {
    return prisma.document.findFirst({ where: { id, organizationId }, include: { file: true } });
  }

  /** Links documents already uploaded (via presign + confirm) to the message they were sent
   * alongside. Scoped to organizationId and consultationId so a caller can't link someone else's
   * document, or one from a different consultation, by guessing an id. */
  /** How many documents were sent with this specific user message (linkToMessage above) — the
   * worker's "is anything actually attached?" check for the missing-attachment guard. */
  static async countForMessage(messageId: string) {
    return prisma.document.count({ where: { messageId } });
  }

  static async linkToMessage(ids: string[], messageId: string, organizationId: string, consultationId: string) {
    await prisma.document.updateMany({ where: { id: { in: ids }, organizationId, consultationId }, data: { messageId } });
  }

  /** Count of a message's attachments still being extracted/indexed (see ChatSvc's attachment wait). */
  static async listNamesByMessage(messageId: string): Promise<string[]> {
    const rows = await prisma.document.findMany({ where: { messageId }, select: { name: true }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => row.name);
  }

  static async countPendingByMessage(messageId: string): Promise<number> {
    return prisma.document.count({ where: { messageId, ragStatus: "PENDING" } });
  }

  /** Unscoped by organizationId — used internally by extraction dispatch, which only ever receives an id
   * of a document it just created/confirmed itself, not a user-supplied id. */
  static async findByIdWithFile(id: string) {
    return prisma.document.findUnique({ where: { id }, include: { file: true } });
  }

  /** Most recently attached document for a consultation — lets chat auto-ground later turns
   * against it without the client having to re-pass caseDocumentId on every message. */
  static async findMostRecentByConsultation(consultationId: string) {
    return prisma.document.findFirst({ where: { consultationId }, orderBy: { createdAt: "desc" } });
  }

  static async update(id: string, organizationId: string, data: { name?: string; caseId?: string | null; consultationId?: string | null; isExhibit?: boolean }) {
    const result = await prisma.document.updateMany({ where: { id, organizationId }, data });
    return result.count > 0;
  }

  static async updateRagStatus(id: string, ragStatus: RagStatus) {
    return prisma.document.update({ where: { id }, data: { ragStatus } });
  }

  static async updateExtractionMeta(
    id: string,
    data: { pageCount?: number | null; extractionMethod?: string | null; ocrAttempted?: boolean; language?: string },
  ) {
    return prisma.document.update({ where: { id }, data });
  }

  /** AI-assigned category (Chat Wonder), distinct from the user-supplied `documentType` —
   * best-effort, so a null/undefined category here just leaves the column unset. */
  static async updateCategory(id: string, category: string) {
    return prisma.document.update({ where: { id }, data: { category } });
  }

  static async delete(id: string, organizationId: string) {
    const result = await prisma.document.deleteMany({ where: { id, organizationId } });
    return result.count > 0;
  }

  /** Archiving is a pure visibility flag (see DocumentStatus on the schema) — this is the one
   * place that flips it. Find-then-update (not updateMany) since this is a genuine
   * user-initiated action with a real 404 to report. */
  static async setStatus(id: string, organizationId: string, status: DocumentStatus) {
    const existing = await prisma.document.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!existing) return null;
    return prisma.document.update({ where: { id }, data: { status }, include: { file: true } });
  }

  /** Deletes empty (0-byte) documents that have sat unresolved (PENDING/FAILED) for at least
   * `olderThanMs` — see DocumentExtractionQueue's eviction sweep for why an empty file has no
   * terminal state to reach on its own and would otherwise loop in `listPendingForExtraction`
   * forever. */
  static async deleteStaleEmpty(olderThanMs: number) {
    return prisma.document.deleteMany({
      where: {
        fileSize: 0,
        ragStatus: { in: ["PENDING", "FAILED"] },
        createdAt: { lt: new Date(Date.now() - olderThanMs) },
      },
    });
  }
}
