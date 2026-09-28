import { describe, it } from "mocha";
import { expect } from "chai";
import { buildCaseTeam, displayName, initialsOf, toAuditEntries } from "../src/utils/case-team";

const user = (id: string, name: string | null, email = `${id}@firm.test`) => ({ id, name, username: null, email });

describe("case-team", () => {
  it("initialsOf uses first+last word, or the first two letters of a single word", () => {
    expect(initialsOf("Lena Chen")).to.equal("LC");
    expect(initialsOf("Ana Maria Cruz")).to.equal("AC");
    expect(initialsOf("vance")).to.equal("VA");
  });

  it("displayName falls back name → username → email local part", () => {
    expect(displayName({ name: " L. Chen ", username: "lc", email: "a@b.c" })).to.equal("L. Chen");
    expect(displayName({ name: null, username: "lc", email: "a@b.c" })).to.equal("lc");
    expect(displayName({ name: null, username: null, email: "a.vance@b.c" })).to.equal("a.vance");
  });

  it("buildCaseTeam lists the owner first and dedupes an owner who also holds a grant", () => {
    const team = buildCaseTeam(user("u1", "Lena Chen"), [
      { permission: "ADMIN", user: user("u1", "Lena Chen") },
      { permission: "EDIT", user: user("u2", "Ana Cruz") },
      { permission: "VIEW", user: user("u3", null, "j.mbeki@firm.test") },
    ]);
    expect(team.map((m) => [m.userId, m.role, m.initials])).to.deep.equal([
      ["u1", "OWNER", "LC"],
      ["u2", "EDIT", "AC"],
      ["u3", "VIEW", "JM"],
    ]);
  });

  it("toAuditEntries names the actor and leaves system events (no actor) null", () => {
    const at = new Date("2026-09-28T09:41:00Z");
    const [human, system] = toAuditEntries([
      { id: "a1", action: "risk.create", createdAt: at, actorId: "u1", actor: user("u1", "Lena Chen") },
      { id: "a2", action: "case.refresh", createdAt: at, actorId: null, actor: null },
    ]);
    expect(human.actorName).to.equal("Lena Chen");
    expect(system.actorName).to.equal(null);
  });

  it("toAuditEntries surfaces only a name/title/label from the payload as `subject`", () => {
    const at = new Date("2026-09-28T09:41:00Z");
    const rows = [
      { id: "a1", action: "risk.create", createdAt: at, actorId: "u1", actor: null, payload: { id: "r1", title: "No written protest", severity: "MAJOR" } },
      { id: "a2", action: "document.failed", createdAt: at, actorId: null, actor: null, payload: { name: "handbook.pdf" } },
      { id: "a3", action: "edge.delete", createdAt: at, actorId: null, actor: null, payload: { id: "e1" } },
    ];
    const [risk, doc, edge] = toAuditEntries(rows);
    expect(risk.subject).to.equal("No written protest");
    expect(doc.subject).to.equal("handbook.pdf");
    expect(edge.subject).to.equal(null);
    expect(risk).to.not.have.property("payload");
  });
});
