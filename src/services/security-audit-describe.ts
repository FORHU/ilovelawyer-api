import type { SecurityAuditEvent } from "@prisma/client";
import SecurityAuditRepo, { AuditNameIds, AuditNames } from "../repositories/security-audit.repository";
import { SECURITY_AUDIT_ACTION_LABELS, SecurityAuditAction } from "../constants/security-audit.constants";
import { normalizeIp } from "../lib/request-context";

/** What the audit log shows for one row — names and plain words, never ids. The same text feeds
 * the app's table and the PDF export, so the two always agree. */
export interface AuditEventDisplay {
  actor: string;
  target: string;
  details: string;
  ip: string;
}

const METHODS: Record<string, string> = {
  password: "password",
  google: "Google",
  google_link: "Google (connecting it to a password account)",
  login_link: "the link in the approval email",
  password_reset: "a password reset link",
  password_update: "a required password update",
  email_verification: "an email verification code",
};

const REASONS: Record<string, string> = {
  self_service: "Changed from their profile",
  required_update: "Required update at sign-in",
  joined_another_organization: "Left to join another organization",
};

const CATEGORY_NAMES: Record<string, string> = {
  "auth.": "Sign-in",
  "org.": "Members and access",
  "account.": "Accounts",
  "export.": "Exports",
  "file.": "File downloads",
  "case.": "Cases",
  "document.": "Documents",
  "consultation.": "Consultations",
  "admin.": "ilovelawyer staff",
};

/** What a deleted case item was, from the route template recordCaseItemDeletions stored. */
const CASE_ITEM_KINDS: [RegExp, string][] = [
  [/\/theories\/:id\/claims\//, "Theory claim"],
  [/\/theories\/:id\/assumptions\//, "Theory assumption"],
  [/\/theories\/:id\/open-questions\//, "Theory open question"],
  [/\/theories\//, "Theory"],
  [/\/findings\//, "Finding"],
  [/\/witnesses\//, "Witness"],
  [/\/damages\//, "Damages item"],
  [/\/claims\//, "Claim"],
  [/\/risks\//, "Key issue"],
  [/\/citation-grounds\//, "Citation ground"],
  [/\/citations\//, "Citation"],
  [/\/authorities\//, "Authority"],
  [/\/edges\//, "Case map link"],
  [/\/timeline\//, "Timeline entry"],
  [/\/custody\//, "Custody record"],
];

const FILE_KINDS: Record<string, string> = {
  document: "Document",
  case_brief: "Case brief",
  generated_document: "Drafted document",
  audio_overview: "Audio Overview",
};

const ROLE_NAMES: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", MANAGER: "Manager", MEMBER: "Member" };
const FORMATS: Record<string, string> = { pdf: "PDF", docx: "Word" };

function role(value: unknown): string {
  return ROLE_NAMES[String(value)] ?? titleCase(String(value));
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function formatDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function pushId(set: Set<string>, value: unknown) {
  if (typeof value === "string" && value) set.add(value);
}

function payloadOf(event: SecurityAuditEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** Every id a page of rows would need a name for. */
export function collectNameIds(events: SecurityAuditEvent[]): AuditNameIds {
  const ids: AuditNameIds = {
    users: new Set(),
    organizations: new Set(),
    cases: new Set(),
    documents: new Set(),
    consultations: new Set(),
    transcriptions: new Set(),
    notes: new Set(),
    briefs: new Set(),
    files: new Set(),
    audioOverviews: new Set(),
    messages: new Set(),
    invites: new Set(),
    integrations: new Set(),
  };
  for (const event of events) {
    const payload = payloadOf(event);
    pushId(ids.users, event.actorId);
    pushId(ids.cases, event.caseId);
    pushId(ids.consultations, payload.consultationId);
    pushId(ids.users, payload.invitedBy);
    pushId(ids.organizations, payload.fromOrganizationId);
    const target = event.targetId;
    switch (event.targetType) {
      case "user":
        pushId(ids.users, target);
        break;
      case "organization":
        pushId(ids.organizations, target);
        break;
      case "case":
        pushId(ids.cases, target);
        break;
      case "document":
        pushId(ids.documents, target);
        break;
      case "consultation":
        pushId(ids.consultations, target);
        break;
      case "transcription":
        pushId(ids.transcriptions, target);
        break;
      case "note":
        pushId(ids.notes, target);
        break;
      case "message":
        pushId(ids.messages, target);
        break;
      case "invite":
        pushId(ids.invites, target);
        break;
      case "integration":
        pushId(ids.integrations, target);
        break;
      case "file":
        if (payload.kind === "case_brief") pushId(ids.briefs, target);
        else if (payload.kind === "audio_overview") pushId(ids.audioOverviews, target);
        else pushId(ids.files, target);
        // export.case_brief names the file; its brief is in the payload.
        pushId(ids.briefs, payload.exportId);
        break;
    }
  }
  return ids;
}

export async function loadNames(events: SecurityAuditEvent[]): Promise<AuditNames> {
  return SecurityAuditRepo.findNames(collectNameIds(events));
}

function quoted(name: string | undefined | null): string | null {
  return name ? `“${name}”` : null;
}

function targetText(event: SecurityAuditEvent, names: AuditNames): string {
  const payload = payloadOf(event);
  const id = event.targetId ?? "";
  const saved = event.targetName;
  const caseName = event.caseId ? names.cases.get(event.caseId) : undefined;
  const inCase = (text: string) => (caseName && event.targetType !== "case" ? `${text} in “${caseName}”` : text);

  switch (event.targetType) {
    case null:
      return caseName ? `“${caseName}”` : "";
    case "user":
      return names.users.get(id) ?? saved ?? (typeof payload.email === "string" ? payload.email : null) ?? "A former user";
    case "organization":
      return names.organizations.get(id) ?? saved ?? "A deleted organization";
    case "case":
      return quoted(names.cases.get(id) ?? saved) ?? "A deleted case";
    case "case_item": {
      const route = String(payload.route ?? "");
      const kind = CASE_ITEM_KINDS.find(([pattern]) => pattern.test(route))?.[1] ?? "Item";
      return inCase(kind);
    }
    case "document":
      return inCase(quoted(names.documents.get(id) ?? saved) ?? "A deleted document");
    case "consultation":
      return quoted(names.consultations.get(id) || saved) ?? "Untitled consultation";
    case "transcription":
      return quoted(names.transcriptions.get(id) || saved) ?? (event.action === "transcription.deleted" ? "A transcription" : "Untitled transcription");
    case "note": {
      const date = names.notes.get(id);
      return date ? `Note for ${formatDate(date)}` : "A note";
    }
    case "message": {
      const consultation = names.messages.get(id) || names.consultations.get(String(payload.consultationId ?? ""));
      return consultation ? `A message in “${consultation}”` : "A message";
    }
    case "invite": {
      const consultation = names.invites.get(id) || names.consultations.get(String(payload.consultationId ?? ""));
      return consultation ? `Invite to “${consultation}”` : "A consultation invite";
    }
    case "integration":
      return payload.type === "google_calendar" ? "Google Calendar" : titleCase(names.integrations.get(id) ?? String(payload.type ?? "Integration"));
    case "file": {
      const kind = String(payload.kind ?? "");
      if (kind === "case_brief" || event.action === "export.case_brief") {
        const brief = names.briefs.get(id) ?? names.briefs.get(String(payload.exportId ?? ""));
        const briefCase = brief ? names.cases.get(brief.caseId) : caseName;
        return briefCase ? `Case brief of “${briefCase}”` : "A case brief";
      }
      if (kind === "audio_overview") {
        const overview = names.audioOverviews.get(id);
        const overviewCase = overview?.caseId ? names.cases.get(overview.caseId) : undefined;
        return overviewCase ? `Audio Overview of “${overviewCase}”` : "An Audio Overview";
      }
      const filename = names.files.get(id);
      return filename ? `“${filename}”` : (FILE_KINDS[kind] ?? "A file");
    }
    case "tenant":
      return `${id} region`;
    case "model_setting":
      return `AI model for ${id}`;
    case "jurisdiction_module":
      return `${id} jurisdiction module`;
    default:
      return "";
  }
}

function filterText(filter: unknown): string {
  if (!filter || typeof filter !== "object") return "all activity";
  const f = filter as Record<string, string>;
  const parts: string[] = [];
  if (f.action) parts.push(CATEGORY_NAMES[f.action] ?? SECURITY_AUDIT_ACTION_LABELS[f.action as SecurityAuditAction] ?? f.action);
  if (f.outcome === "FAILURE") parts.push("failed attempts only");
  if (f.from && f.to) parts.push(`${formatDate(f.from)} – ${formatDate(new Date(new Date(f.to).getTime() - 1))}`);
  else if (f.from) parts.push(`from ${formatDate(f.from)}`);
  else if (f.to) parts.push(`until ${formatDate(f.to)}`);
  return parts.length ? parts.join(", ") : "all activity";
}

/** The row's payload in plain words. Ids, internal codes and anything already said in the target
 * column are left out. */
function detailsText(event: SecurityAuditEvent, names: AuditNames): string {
  const p = payloadOf(event);
  const parts: string[] = [];
  const action = event.action as SecurityAuditAction;

  if (typeof p.method === "string") parts.push(`With ${METHODS[p.method] ?? p.method}`);
  if (event.outcome === "FAILURE" && typeof p.reason === "string") parts.push(p.reason);
  else if (typeof p.reason === "string") parts.push(REASONS[p.reason] ?? p.reason);
  // A failed sign-in for an address with no account: the target column is empty, so say which.
  if (typeof p.email === "string" && !event.targetId && action !== "email.sent") parts.push(`Email tried: ${p.email}`);

  if (action === "email.sent" && typeof p.to === "string") parts.push(`To ${p.to}`);
  else if (p.from !== undefined && p.to !== undefined) {
    const isRole = action === "org.member_role_changed";
    const isSwitch = typeof p.from === "boolean";
    const show = (v: unknown) => (isRole ? role(v) : isSwitch ? (v ? "On" : "Off") : v === null ? "none" : String(v));
    parts.push(`${show(p.from)} → ${show(p.to)}`);
  }
  if (p.role !== undefined && action !== "org.member_role_changed") parts.push(`Role: ${role(p.role)}`);
  if (p.permission !== undefined) parts.push(`Access: ${titleCase(String(p.permission))}`);
  if (Array.isArray(p.fields) && p.fields.length) parts.push(`Changed: ${p.fields.join(", ")}`);
  if (p.packageSku !== undefined) parts.push(`Plan: ${titleCase(String(p.packageSku))}`);
  if (typeof p.format === "string" && action !== "email.sent") parts.push(FORMATS[p.format] ?? p.format.toUpperCase());
  if (typeof p.rowCount === "number") parts.push(`${p.rowCount} event${p.rowCount === 1 ? "" : "s"}${p.truncated ? " (newest only)" : ""}`);
  if (action === "export.audit_log") parts.push(`Showing ${filterText(p.filter)}`);
  if (p.kind !== undefined && event.targetType === "document") parts.push("Opened from its link");
  if (typeof p.documentsDeleted === "number" && p.documentsDeleted > 0)
    parts.push(`${p.documentsDeleted} document${p.documentsDeleted === 1 ? "" : "s"} deleted with it`);
  if (p.scheduledFor) parts.push(`Scheduled for ${formatDate(p.scheduledFor)}`);
  if (p.deletionScheduledFor) parts.push(`Permanently removed on ${formatDate(p.deletionScheduledFor)}`);
  if (p.via === "sign_in") parts.push("Cancelled by signing in");
  if (p.via === "api_key") parts.push("By the ilovelawyer service");
  if (p.autoApproved === true) parts.push("Account approved automatically");
  if (typeof p.enabled === "boolean") parts.push(p.enabled ? "Turned on" : "Turned off");
  if (p.bulk === true) parts.push(`Bulk approval: ${p.approved ?? 0} approved, ${p.skipped ?? 0} skipped, ${p.failed ?? 0} failed`);
  if (typeof p.invitedBy === "string") {
    const inviter = names.users.get(p.invitedBy);
    if (inviter) parts.push(`Invited by ${inviter}`);
  }
  if (typeof p.fromOrganizationId === "string") {
    const from = names.organizations.get(p.fromOrganizationId);
    if (from) parts.push(`From ${from}`);
  }
  return parts.join(" · ");
}

/** Shown in any cell with nothing to say, so an empty cell never looks like missing data. */
export const NOT_APPLICABLE = "N/A";

export function describeAuditEvent(event: SecurityAuditEvent, names: AuditNames): AuditEventDisplay {
  const actor = event.actorId ? (names.users.get(event.actorId) ?? event.actorEmail ?? "A former user") : "No signed-in user";
  return {
    actor,
    target: targetText(event, names) || NOT_APPLICABLE,
    details: detailsText(event, names) || NOT_APPLICABLE,
    ip: normalizeIp(event.ip) ?? NOT_APPLICABLE,
  };
}
