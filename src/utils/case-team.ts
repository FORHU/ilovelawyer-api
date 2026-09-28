import { CasePermission } from "@prisma/client";

export interface TeamUser {
  id: string;
  name: string | null;
  username?: string | null;
  email: string;
}

export interface CaseTeamMember {
  userId: string;
  name: string;
  initials: string;
  role: "OWNER" | CasePermission;
}

/** name → username → email local part, so a member is never rendered as a raw id. */
export function displayName(user: Pick<TeamUser, "name" | "username" | "email">): string {
  return user.name?.trim() || user.username?.trim() || user.email.split("@")[0];
}

export function initialsOf(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** The case owner first, then everyone with an explicit CaseAccess grant (owner deduped). */
export function buildCaseTeam(
  owner: TeamUser | null | undefined,
  accesses: { permission: CasePermission; user: TeamUser }[],
): CaseTeamMember[] {
  const team: CaseTeamMember[] = [];
  const seen = new Set<string>();
  const add = (user: TeamUser, role: CaseTeamMember["role"]) => {
    if (seen.has(user.id)) return;
    seen.add(user.id);
    const name = displayName(user);
    team.push({ userId: user.id, name, initials: initialsOf(name), role });
  };
  if (owner) add(owner, "OWNER");
  for (const access of accesses) add(access.user, access.permission);
  return team;
}

export interface AuditRow {
  id: string;
  action: string;
  createdAt: Date;
  actorId: string | null;
  actor?: TeamUser | null;
  payload?: unknown;
}

/** The human-readable thing an event acted on ("No written protest", "handbook.pdf"), taken from
 * the payload's name/title/label — null when the writer only recorded ids. Only these keys are
 * surfaced; the rest of the payload stays server-side. */
function subjectOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["name", "title", "label"]) {
    const value = p[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return null;
}

/** Actor is null for system-generated events (no actorId, or the user was since deleted). */
export function toAuditEntry(row: AuditRow) {
  return {
    id: row.id,
    action: row.action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorName: row.actor ? displayName(row.actor) : null,
    subject: subjectOf(row.payload),
  };
}

export const toAuditEntries = (rows: AuditRow[]) => rows.map(toAuditEntry);
