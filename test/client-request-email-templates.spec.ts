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

  it("closed, for the client: what happened, what happens to their money, and a link to the case", async () => {
    const html = await renderTemplate("client-request-closed-client", {
      heading: "Lena Lawyer can't continue with your case",
      message: "Lena Lawyer has stopped acting on your case, and no longer has access to it.",
      refund: "We're refunding your payment in full.",
      next: "You can ask for another lawyer from your case whenever you're ready.",
      caseLink: "https://ilovelawyer.com/cases/case-1",
    });
    for (const text of ["can&#x27;t continue", "refunding your payment in full", "ask for another lawyer", "https://ilovelawyer.com/cases/case-1"]) expect(html).to.include(text);

    const finished = await renderTemplate("client-request-closed-client", { heading: "Closed", message: "Done.", refund: null, next: "Rate your lawyer.", caseLink: "https://ilovelawyer.com/cases/case-1" });
    expect(finished).to.not.include("refunding");
  });

  it("expired, for the client: they can ask again from their case", async () => {
    const html = await renderTemplate("client-request-expired-client", { caseLink: "https://ilovelawyer.com/cases/case-1" });
    expect(html).to.include("https://ilovelawyer.com/cases/case-1");
  });
});
