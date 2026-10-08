import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export interface ListAuditEventsParams {
  page: number;
  limit: number;
  sortDir: "asc" | "desc";
  /** Matches the action name or the actor's email, case-insensitively. */
  q?: string;
  actorId?: string;
}

/** Payload keys that hold an id the admin page should show as a name. */
const ORGANIZATION_KEYS = ["organizationId", "orgId"];
const USER_KEYS = ["targetUserId", "inviteeId", "userId"];

export interface ResolvedAuditReferences {
  organizations: Record<string, string>;
  users: Record<string, { email: string; name: string | null }>;
  cases: Record<string, string>;
}

function idsAt(payloads: Array<Prisma.JsonValue | null>, keys: string[]): string[] {
  const ids = new Set<string>();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") ids.add(value);
    }
  }
  return [...ids];
}

export default class AuditEventRepo {
  /** Newest first by default. `actor` is null when the user has since been deleted (the FK is
   * ON DELETE SET NULL). `resolved` maps the ids that appear in these rows to readable names; an
   * id that no longer exists (a deleted organization, user or case) is simply absent from it. */
  static async list(params: ListAuditEventsParams) {
    const { page, limit, sortDir, q, actorId } = params;

    const where: Prisma.AuditEventWhereInput = {
      ...(actorId ? { actorId } : {}),
      ...(q
        ? {
            OR: [
              { action: { contains: q, mode: "insensitive" } },
              { actor: { email: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [data, total] = await prisma.$transaction([
      prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: sortDir }, { id: sortDir }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          action: true,
          caseId: true,
          payload: true,
          createdAt: true,
          actor: { select: { id: true, email: true, name: true } },
        },
      }),
      prisma.auditEvent.count({ where }),
    ]);

    const payloads = data.map((row) => row.payload);
    const organizationIds = idsAt(payloads, ORGANIZATION_KEYS);
    const userIds = idsAt(payloads, USER_KEYS);
    const caseIds = [...new Set([...data.map((row) => row.caseId).filter((id): id is string => !!id), ...idsAt(payloads, ["caseId"])])];

    const [organizations, users, cases] = await Promise.all([
      organizationIds.length ? prisma.organization.findMany({ where: { id: { in: organizationIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : [],
      caseIds.length ? prisma.case.findMany({ where: { id: { in: caseIds } }, select: { id: true, caseName: true } }) : [],
    ]);

    const resolved: ResolvedAuditReferences = {
      organizations: Object.fromEntries(organizations.map((o) => [o.id, o.name])),
      users: Object.fromEntries(users.map((u) => [u.id, { email: u.email, name: u.name }])),
      cases: Object.fromEntries(cases.map((c) => [c.id, c.caseName])),
    };

    return { data, total, resolved };
  }
}
