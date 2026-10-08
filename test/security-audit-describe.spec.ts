/** describeAuditEvent — what the audit log shows for a row: names and plain words, never ids, and
 * "N/A" wherever there's nothing to say. Pure function; the names come in as a map, the way
 * SecurityAuditRepo.findNames returns them. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { collectNameIds, describeAuditEvent } from "../src/services/security-audit-describe";
import type { AuditNames } from "../src/repositories/security-audit.repository";

function names(overrides: Partial<Record<keyof AuditNames, Map<string, unknown>>> = {}): AuditNames {
  const empty = () => new Map();
  return {
    users: new Map([
      ["u-felix", "Felix Miguel Galpao"],
      ["u-wipper", "Wipper"],
    ]),
    organizations: new Map([["org-1", "Audit QA Firm"]]),
    cases: new Map([["case-1", "Smith v Jones"]]),
    documents: new Map([["doc-1", "Affidavit.pdf"]]),
    consultations: new Map([["con-1", "Lease dispute"]]),
    transcriptions: empty(),
    notes: empty(),
    briefs: new Map([["brief-1", { format: "pdf", caseId: "case-1" }]]),
    files: empty(),
    audioOverviews: new Map([["ao-1", { caseId: "case-1" }]]),
    messages: empty(),
    invites: empty(),
    integrations: empty(),
    ...overrides,
  } as AuditNames;
}

function event(overrides: object) {
  return {
    id: "e-1",
    createdAt: new Date("2026-10-08T05:51:00Z"),
    action: "auth.login",
    outcome: "SUCCESS",
    organizationId: "org-1",
    tenantCode: "PH",
    actorId: "u-felix",
    actorEmail: "felix@firm.test",
    targetType: null,
    targetId: null,
    targetName: null,
    caseId: null,
    ip: "127.0.0.1",
    userAgent: "x",
    requestId: "r",
    payload: null,
    ...overrides,
  } as any;
}

describe("describeAuditEvent", () => {
  it("names the organization of an audit log export and says what it covered", () => {
    const display = describeAuditEvent(
      event({
        action: "export.audit_log",
        targetType: "organization",
        targetId: "org-1",
        payload: { filter: {}, format: "pdf", rowCount: 22, truncated: false },
      }),
      names(),
    );
    expect(display).to.deep.equal({
      actor: "Felix Miguel Galpao",
      target: "Audit QA Firm",
      details: "PDF · 22 events · Showing all activity",
      ip: "127.0.0.1",
    });
  });

  it("names a deleted document by the name it had, and the case it was in", () => {
    const display = describeAuditEvent(
      event({
        action: "document.deleted",
        targetType: "document",
        targetId: "doc-gone",
        targetName: "Lease.pdf",
        caseId: "case-1",
        payload: { consultationId: null, ragStatus: "READY" },
      }),
      names(),
    );
    expect(display.target).to.equal("“Lease.pdf” in “Smith v Jones”");
    expect(display.details).to.equal("N/A");
  });

  it("names an Audio Overview download by its case, without file ids or link internals", () => {
    const display = describeAuditEvent(
      event({
        action: "file.accessed",
        targetType: "file",
        targetId: "ao-1",
        ip: "::ffff:127.0.0.1",
        payload: { via: "file_link", kind: "audio_overview", disposition: "attachment" },
      }),
      names(),
    );
    expect(display).to.deep.equal({
      actor: "Felix Miguel Galpao",
      target: "Audio Overview of “Smith v Jones”",
      details: "N/A",
      ip: "127.0.0.1",
    });
  });

  it("names members and spells out role changes", () => {
    const display = describeAuditEvent(
      event({ action: "org.member_role_changed", targetType: "user", targetId: "u-wipper", payload: { from: "MEMBER", to: "MANAGER" } }),
      names(),
    );
    expect(display.target).to.equal("Wipper");
    expect(display.details).to.equal("Member → Manager");
  });

  it("describes an invite by role and, once accepted, profile edits by field", () => {
    expect(
      describeAuditEvent(
        event({ action: "org.member_invited", targetType: "user", targetId: "u-wipper", payload: { role: "MEMBER", email: "wipper@x.test" } }),
        names(),
      ).details,
    ).to.equal("Role: Member");
    expect(
      describeAuditEvent(event({ action: "account.profile_updated", targetType: "user", targetId: "u-wipper", payload: { fields: ["name"] } }), names())
        .details,
    ).to.equal("Changed: name");
  });

  it("says what kind of item was deleted from a case, from the stored route", () => {
    const display = describeAuditEvent(
      event({
        action: "case.item_deleted",
        targetType: "case_item",
        targetId: "f-9",
        caseId: "case-1",
        payload: { route: "/my-cases/:caseId/findings/:id" },
      }),
      names(),
    );
    expect(display.target).to.equal("Finding in “Smith v Jones”");
    expect(display.details).to.equal("N/A");
  });

  it("explains a failed sign-in, and names an unknown address only in the details", () => {
    const known = describeAuditEvent(
      event({
        action: "auth.login",
        outcome: "FAILURE",
        actorId: null,
        actorEmail: null,
        targetType: "user",
        targetId: "u-wipper",
        payload: { method: "password", email: "wipper@x.test", reason: "Invalid email or password", status: 401 },
      }),
      names(),
    );
    expect(known).to.include({ actor: "No signed-in user", target: "Wipper", details: "With password · Invalid email or password" });

    const unknown = describeAuditEvent(
      event({ action: "auth.login", outcome: "FAILURE", actorId: null, payload: { method: "password", email: "nobody@x.test", reason: "Invalid email or password" } }),
      names(),
    );
    expect(unknown).to.include({ target: "N/A", details: "With password · Invalid email or password · Email tried: nobody@x.test" });
  });

  it("falls back to the saved email, then to plain words, when a person or thing is gone", () => {
    const gone = describeAuditEvent(event({ actorId: "u-deleted", actorEmail: "old@firm.test", targetType: "case", targetId: "case-gone" }), names());
    expect(gone.actor).to.equal("old@firm.test");
    expect(gone.target).to.equal("A deleted case");
    expect(describeAuditEvent(event({ ip: null }), names()).ip).to.equal("N/A");
  });

  it("collects every id a page needs named, by kind", () => {
    const ids = collectNameIds([
      event({ targetType: "document", targetId: "doc-1", caseId: "case-1" }),
      event({ targetType: "file", targetId: "ao-1", payload: { kind: "audio_overview" } }),
      event({ targetType: "file", targetId: "brief-1", payload: { kind: "case_brief" } }),
    ]);
    expect([...ids.documents]).to.deep.equal(["doc-1"]);
    expect([...ids.cases]).to.deep.equal(["case-1"]);
    expect([...ids.audioOverviews]).to.deep.equal(["ao-1"]);
    expect([...ids.briefs]).to.deep.equal(["brief-1"]);
    expect([...ids.users]).to.deep.equal(["u-felix"]);
  });
});
