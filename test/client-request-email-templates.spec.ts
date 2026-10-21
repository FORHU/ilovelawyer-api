/** The client request emails (#510) render through MJML with what ClientRequestNotifySvc gives
 * them: a broken template fails here, not when the sweep tries to send it. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { renderTemplate } from "../src/utils/template";

describe("client request email templates", () => {
  it("new request: the area, part of the UK, urgency and when it closes, with a link to the inbox", async () => {
    const html = await renderTemplate("client-request-new", {
      practiceArea: "Employment",
      ukJurisdiction: "England and Wales",
      urgency: "Urgent: a deadline within 7 days",
      routingExpiresAt: "Friday 23 October 2026 at 10:00",
      inboxLink: "https://uk.ilovelawyer.com/homepage/client-requests",
    });
    for (const text of ["Employment", "England and Wales", "Urgent: a deadline within 7 days", "Friday 23 October 2026 at 10:00", "https://uk.ilovelawyer.com/homepage/client-requests"]) {
      expect(html).to.include(text);
    }
  });

  it("claim expiring: when the hold ends, with a link to the request", async () => {
    const html = await renderTemplate("client-request-claim-expiring", {
      claimExpiresAt: "Thursday 22 October 2026 at 11:00",
      inboxLink: "https://uk.ilovelawyer.com/homepage/client-requests",
    });
    expect(html).to.include("Thursday 22 October 2026 at 11:00");
    expect(html).to.include("https://uk.ilovelawyer.com/homepage/client-requests");
  });

  it("expired, for ops: one row per request", async () => {
    const html = await renderTemplate("client-request-expired-ops", {
      count: "2",
      requests: [
        { id: "req-1", practiceArea: "Employment", ukJurisdiction: "England and Wales", routedAt: "Tuesday 20 October 2026 at 09:00", matchingLawyers: 3 },
        { id: "req-2", practiceArea: "Family", ukJurisdiction: "Scotland", routedAt: "Tuesday 20 October 2026 at 09:30", matchingLawyers: 0 },
      ],
    });
    for (const text of ["req-1", "req-2", "Family", "Scotland"]) expect(html).to.include(text);
  });

  it("expired, for the client: they can ask again from their case", async () => {
    const html = await renderTemplate("client-request-expired-client", { caseLink: "https://ilovelawyer.com/cases/case-1" });
    expect(html).to.include("https://ilovelawyer.com/cases/case-1");
  });
});
