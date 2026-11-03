/** shownStatus: the status a request shows its client and admins (several lawyers, phase 5). Pure. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { shownStatus } from "../src/utils/client-request-status";

const open = (quoted: boolean) => ({ outcome: null, quotedAt: quoted ? new Date() : null });
const ended = { outcome: "LAPSED" as const, quotedAt: null };

describe("shownStatus", () => {
  it("is ROUTED with nobody on the request, CLAIMED once someone joins, QUOTED once anyone quotes", () => {
    expect(shownStatus("ROUTED", [])).to.equal("ROUTED");
    expect(shownStatus("ROUTED", [open(false)])).to.equal("CLAIMED");
    expect(shownStatus("ROUTED", [open(false), open(true)])).to.equal("QUOTED");
  });

  it("counts only open claims: one that ended doesn't hold the request", () => {
    expect(shownStatus("ROUTED", [ended])).to.equal("ROUTED");
    expect(shownStatus("ROUTED", [ended, open(true)])).to.equal("QUOTED");
  });

  it("leaves every other status as it is", () => {
    for (const status of ["CONFIRMED", "ENGAGED", "CLOSED", "EXPIRED", "WITHDRAWN"] as const) expect(shownStatus(status, [open(true)])).to.equal(status);
  });
});
