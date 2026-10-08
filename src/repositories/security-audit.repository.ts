import { Prisma, SecurityAuditOutcome } from "@prisma/client";
import prisma from "../lib/prisma";

export interface SecurityAuditFilter {
  /** undefined = every organization (platform admins); null = only rows with no organization. */
  organizationId?: string | null;
  actorId?: string;
  caseId?: string;
  /** An exact action, or a prefix ending in "." ("auth.") for a whole group. */
  action?: string;
  outcome?: SecurityAuditOutcome;
  from?: Date;
  to?: Date;
}

function toWhere(filter: SecurityAuditFilter): Prisma.SecurityAuditEventWhereInput {
  const where: Prisma.SecurityAuditEventWhereInput = {};
  if (filter.organizationId !== undefined) where.organizationId = filter.organizationId;
  if (filter.actorId) where.actorId = filter.actorId;
  if (filter.caseId) where.caseId = filter.caseId;
  if (filter.action) where.action = filter.action.endsWith(".") ? { startsWith: filter.action } : filter.action;
  if (filter.outcome) where.outcome = filter.outcome;
  if (filter.from || filter.to) where.createdAt = { ...(filter.from && { gte: filter.from }), ...(filter.to && { lt: filter.to }) };
  return where;
}

export interface AuditNameIds {
  users: Set<string>;
  organizations: Set<string>;
  cases: Set<string>;
  documents: Set<string>;
  consultations: Set<string>;
  transcriptions: Set<string>;
  notes: Set<string>;
  briefs: Set<string>;
  files: Set<string>;
  audioOverviews: Set<string>;
  messages: Set<string>;
  invites: Set<string>;
  integrations: Set<string>;
}

export interface AuditNames {
  users: Map<string, string>;
  organizations: Map<string, string>;
  cases: Map<string, string>;
  documents: Map<string, string>;
  consultations: Map<string, string>;
  transcriptions: Map<string, string>;
  notes: Map<string, Date>;
  briefs: Map<string, { format: string; caseId: string }>;
  files: Map<string, string>;
  audioOverviews: Map<string, { caseId: string | null }>;
  messages: Map<string, string>;
  invites: Map<string, string>;
  integrations: Map<string, string>;
}

/** Newest first; the id breaks ties between rows written in the same millisecond. */
const ORDER: Prisma.SecurityAuditEventOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

export default class SecurityAuditRepo {
  static async create(data: Prisma.SecurityAuditEventUncheckedCreateInput) {
    return prisma.securityAuditEvent.create({ data });
  }

  /** The actor's email (snapshotted onto the row) and the one organization they belong to. */
  static async findUserAuditInfo(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        organizationMemberships: { select: { organizationId: true, organization: { select: { tenant: { select: { code: true } } } } } },
      },
    });
  }

  static async findUserIdByEmail(email: string) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    return user?.id ?? null;
  }

  static async findOrganizationTenantCode(organizationId: string) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { tenant: { select: { code: true } } } });
    return org?.tenant.code ?? null;
  }

  /** Up to `take` rows, newest first, after skipping the first `skip`. */
  static async list(filter: SecurityAuditFilter, take: number, skip = 0) {
    return prisma.securityAuditEvent.findMany({ where: toWhere(filter), orderBy: ORDER, take, skip });
  }

  static async count(filter: SecurityAuditFilter) {
    return prisma.securityAuditEvent.count({ where: toWhere(filter) });
  }

  /** Current names for the ids a page of rows mentions, one query per kind — the rows themselves
   * hold ids only, so a rename shows up and nothing stored goes stale. Ids that no longer exist
   * are simply missing from the result. */
  static async findNames(ids: AuditNameIds): Promise<AuditNames> {
    const some = (list: Set<string>) => (list.size ? [...list] : null);
    const [users, organizations, cases, documents, consultations, transcriptions, notes, briefs, files, audioOverviews, messages, invites, integrations] =
      await Promise.all([
        some(ids.users) ? prisma.user.findMany({ where: { id: { in: some(ids.users)! } }, select: { id: true, name: true, email: true } }) : [],
        some(ids.organizations) ? prisma.organization.findMany({ where: { id: { in: some(ids.organizations)! } }, select: { id: true, name: true } }) : [],
        some(ids.cases) ? prisma.case.findMany({ where: { id: { in: some(ids.cases)! } }, select: { id: true, caseName: true } }) : [],
        some(ids.documents) ? prisma.document.findMany({ where: { id: { in: some(ids.documents)! } }, select: { id: true, name: true } }) : [],
        some(ids.consultations) ? prisma.consultation.findMany({ where: { id: { in: some(ids.consultations)! } }, select: { id: true, title: true } }) : [],
        some(ids.transcriptions) ? prisma.transcription.findMany({ where: { id: { in: some(ids.transcriptions)! } }, select: { id: true, title: true } }) : [],
        some(ids.notes) ? prisma.note.findMany({ where: { id: { in: some(ids.notes)! } }, select: { id: true, date: true } }) : [],
        some(ids.briefs) ? prisma.caseBriefExport.findMany({ where: { id: { in: some(ids.briefs)! } }, select: { id: true, format: true, caseId: true } }) : [],
        some(ids.files) ? prisma.file.findMany({ where: { id: { in: some(ids.files)! } }, select: { id: true, filename: true } }) : [],
        some(ids.audioOverviews)
          ? prisma.messageAudioOverview.findMany({ where: { id: { in: some(ids.audioOverviews)! } }, select: { id: true, caseId: true } })
          : [],
        some(ids.messages)
          ? prisma.message.findMany({ where: { id: { in: some(ids.messages)! } }, select: { id: true, consultation: { select: { title: true } } } })
          : [],
        some(ids.invites)
          ? prisma.consultationInvite.findMany({ where: { id: { in: some(ids.invites)! } }, select: { id: true, consultation: { select: { title: true } } } })
          : [],
        some(ids.integrations) ? prisma.integrationConnector.findMany({ where: { id: { in: some(ids.integrations)! } }, select: { id: true, type: true } }) : [],
      ]);

    // A brief or audio overview names its case — fetch any case not already on the page.
    const extraCaseIds = [...briefs.map((b) => b.caseId), ...audioOverviews.map((a) => a.caseId)].filter(
      (id): id is string => !!id && !cases.some((c) => c.id === id),
    );
    const extraCases = extraCaseIds.length
      ? await prisma.case.findMany({ where: { id: { in: extraCaseIds } }, select: { id: true, caseName: true } })
      : [];

    return {
      users: new Map(users.map((u) => [u.id, u.name || u.email])),
      organizations: new Map(organizations.map((o) => [o.id, o.name])),
      cases: new Map([...cases, ...extraCases].map((c) => [c.id, c.caseName])),
      documents: new Map(documents.map((d) => [d.id, d.name])),
      consultations: new Map(consultations.map((c) => [c.id, c.title ?? ""])),
      transcriptions: new Map(transcriptions.map((t) => [t.id, t.title ?? ""])),
      notes: new Map(notes.map((n) => [n.id, n.date])),
      briefs: new Map(briefs.map((b) => [b.id, { format: b.format, caseId: b.caseId }])),
      files: new Map(files.map((f) => [f.id, f.filename ?? ""])),
      audioOverviews: new Map(audioOverviews.map((a) => [a.id, { caseId: a.caseId }])),
      messages: new Map(messages.map((m) => [m.id, m.consultation?.title ?? ""])),
      invites: new Map(invites.map((i) => [i.id, i.consultation?.title ?? ""])),
      integrations: new Map(integrations.map((i) => [i.id, String(i.type)])),
    };
  }

  /** Deletes up to `take` rows older than `cutoff`, oldest first; returns how many went. The
   * database refuses any row younger than the retention floor (see the migration's trigger). */
  static async deleteOlderThan(cutoff: Date, take: number): Promise<number> {
    const rows = await prisma.securityAuditEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
      take,
    });
    if (!rows.length) return 0;
    const { count } = await prisma.securityAuditEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return count;
  }
}
