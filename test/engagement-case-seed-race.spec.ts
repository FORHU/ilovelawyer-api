/** Task 10's load-bearing fix: a client-invite redemption (CaseLawyerInviteSvc.redeem, Task 7) and a
 * marketplace engagement reaching ENGAGED (QuotationPaymentSvc.afterEngaged / OrganizationChargeSvc's
 * equivalent, Task 10) both take the identical `SELECT ... FOR UPDATE` lock on the case's `Case` row
 * before seeding a lawyer-owned Case and recording it, so a case is never left with two different
 * lawyers' Cases pointing at it. This races the two paths against each other directly (not just
 * invite-vs-invite, already covered by case-lawyer-invite.spec.ts) by stubbing `CaseSeedSvc.seed` —
 * the slow, shared step both paths sit on while the other's write can land — the same technique
 * case-lawyer-invite.spec.ts's own race tests use.
 */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import CaseLawyerInviteRepo from "../src/repositories/case-lawyer-invite.repository";
import CaseLawyerInviteSvc from "../src/services/case-lawyer-invite.service";
import CaseSeedSvc from "../src/services/case-seed.service";
import QuotationPaymentSvc from "../src/services/quotation-payment.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";

describe("ClientRequestRepo.findEngagedLawyerForCase's excludeRequestId (Task 10, Critical #1 fix)", function () {
  this.timeout(10_000);
  const clientId = crypto.randomUUID();
  const lawyerAId = crypto.randomUUID();
  const lawyerBId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  before(async () => {
    await prisma.user.create({ data: { id: clientId, email: `exclude-client-${clientId}@example.com`, username: `exclude-client-${clientId}` } });
    await prisma.user.create({ data: { id: lawyerAId, email: `exclude-a-${lawyerAId}@example.com`, username: `exclude-a-${lawyerAId}` } });
    await prisma.user.create({ data: { id: lawyerBId, email: `exclude-b-${lawyerBId}@example.com`, username: `exclude-b-${lawyerBId}` } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Exclusion test", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  after(async () => {
    await prisma.clientRequestClaim.deleteMany({ where: { request: { caseId } } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: { in: [clientId, lawyerAId, lawyerBId] } } });
  });

  // Deterministic by construction, not by Postgres's (unspecified) row-return order: with two
  // ENGAGED ClientRequests on the same case, excluding either one's id must always leave exactly
  // the *other* one as the answer — never itself, and never undecided based on which happened to be
  // inserted or updated first. This is the exact gap Critical #1 flagged: the old call site
  // (`findEngagedLawyerForCase(caseId, tx)` + a JS-side `engaged.requestId !== requestId` check)
  // could silently miss a genuine conflict whenever the plain `findFirst` happened to return the
  // caller's own row.
  it("always returns the other ENGAGED request, excluding the caller's own, regardless of which was written first", async () => {
    const requestA = await prisma.clientRequest.create({ data: { caseId, clientId, status: "ENGAGED", engagedAt: new Date(), consentVersion: "v1", consentAcceptedAt: new Date() } });
    await prisma.clientRequestClaim.create({ data: { requestId: requestA.id, lawyerId: lawyerAId, outcome: "ENGAGED", claimedAt: new Date(), expiresAt: future } });
    const requestB = await prisma.clientRequest.create({ data: { caseId, clientId, status: "ENGAGED", engagedAt: new Date(), consentVersion: "v1", consentAcceptedAt: new Date() } });
    await prisma.clientRequestClaim.create({ data: { requestId: requestB.id, lawyerId: lawyerBId, outcome: "ENGAGED", claimedAt: new Date(), expiresAt: future } });

    // Excluding A's own id must find B, excluding B's own id must find A — both directions, so this
    // isn't just testing whichever one Postgres happens to prefer.
    const foundExcludingA = await ClientRequestRepo.findEngagedLawyerForCase(caseId, undefined, requestA.id);
    expect(foundExcludingA?.requestId).to.equal(requestB.id);
    const foundExcludingB = await ClientRequestRepo.findEngagedLawyerForCase(caseId, undefined, requestB.id);
    expect(foundExcludingB?.requestId).to.equal(requestA.id);

    // With no exclusion, it's still just "the first ENGAGED one" — some row, not necessarily either
    // in particular; the exclusion is what makes the "is there a *different* one" question answerable.
    const foundNoExclusion = await ClientRequestRepo.findEngagedLawyerForCase(caseId);
    expect([requestA.id, requestB.id]).to.include(foundNoExclusion?.requestId);
  });
});

describe("a client invite and a marketplace engagement racing for the same case (Task 10)", function () {
  this.timeout(20_000);
  const clientId = crypto.randomUUID();
  const inviteLawyerId = crypto.randomUUID();
  const marketLawyerId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const makeToken = () => `tok-${crypto.randomUUID()}`;

  before(async () => {
    await prisma.user.create({ data: { id: clientId, email: `race-client-${clientId}@example.com`, username: `race-client-${clientId}` } });
    await prisma.user.create({ data: { id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com`, username: `race-invite-lawyer-${inviteLawyerId}`, role: "LAWYER" } });
    await prisma.user.create({ data: { id: marketLawyerId, email: `race-market-lawyer-${marketLawyerId}@example.com`, username: `race-market-lawyer-${marketLawyerId}`, role: "LAWYER" } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Race case", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  afterEach(async () => {
    await prisma.case.deleteMany({ where: { copiedFromCaseId: caseId } });
    await prisma.quotation.deleteMany({ where: { request: { caseId } } });
    await prisma.clientRequestClaim.deleteMany({ where: { request: { caseId } } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
  });

  after(async () => {
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: { in: [clientId, inviteLawyerId, marketLawyerId] } } });
  });

  /** The marketplace side's own ClientRequest+Claim+Quotation in `status` (not yet ENGAGED). */
  async function marketplaceRequest(status: "CONFIRMED" | "ROUTED", quotationStatus: "ACCEPTED" | "PAID") {
    const marketRequest = await prisma.clientRequest.create({
      data: { caseId, clientId, status, consentVersion: "v1", consentAcceptedAt: new Date() },
    });
    const marketClaim = await prisma.clientRequestClaim.create({
      data: { requestId: marketRequest.id, lawyerId: marketLawyerId, organizationId: null, claimedAt: new Date(), expiresAt: future },
    });
    const quotation = await prisma.quotation.create({
      data: {
        claimId: marketClaim.id,
        requestId: marketRequest.id,
        lawyerId: marketLawyerId,
        type: "FIXED_FEE",
        serviceFeeMinor: 51000,
        platformFeeBps: 1500,
        platformFeeMinor: 9000,
        totalAmountMinor: 60000,
        expiresAt: future,
        status: quotationStatus,
      },
    });
    return { marketRequest, marketClaim, quotation };
  }

  it("the marketplace engagement wins: it lands first, so the invite's own lock+recheck (Task 7) catches the conflict and aborts", async () => {
    const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

    const originalSeed = CaseSeedSvc.seed;
    let marketplaceSeededCaseId: string | undefined;
    let triggered = false;
    // The case has no open request when the invite is redeemed, so redeem's pre-seed check passes.
    // While its seed() (the slow, shared step) is in flight, a marketplace request appears and
    // settles (created and flipped ENGAGED, as QuotationPaymentRepo.settle would) and the real
    // afterEngaged runs — which takes the identical Case-row lock and, finding no competing ENGAGED
    // request yet (the invite hasn't created its ClientRequest yet; that only happens after seed()
    // returns), seeds and records its own Case normally. Guarded by `triggered` so afterEngaged's
    // own nested seed() call (for the marketplace Case itself) doesn't recurse.
    CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
      if (!triggered) {
        triggered = true;
        const { marketRequest, marketClaim, quotation } = await marketplaceRequest("CONFIRMED", "ACCEPTED");
        await prisma.clientRequest.update({ where: { id: marketRequest.id }, data: { status: "ENGAGED", engagedAt: new Date() } });
        await prisma.clientRequestClaim.update({ where: { id: marketClaim.id }, data: { outcome: "ENGAGED" } });
        await QuotationPaymentSvc.afterEngaged(quotation, { organizationId: null, lawyerId: marketLawyerId }, 0, null, "GBP");
        const marketClaimAfter = await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: marketClaim.id } });
        marketplaceSeededCaseId = marketClaimAfter.lawyerCaseId ?? undefined;
      }
      return originalSeed(input);
    }) as typeof CaseSeedSvc.seed;

    let result: unknown;
    try {
      result = await CaseLawyerInviteSvc.redeem({ id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com` }, invite.token);
    } finally {
      CaseSeedSvc.seed = originalSeed;
    }

    // The marketplace engagement won: it got here first (its own lock+recheck inside afterEngaged
    // saw no conflict) and kept its seeded Case.
    expect(marketplaceSeededCaseId).to.be.a("string");
    const marketCase = await prisma.case.findUniqueOrThrow({ where: { id: marketplaceSeededCaseId! } });
    expect(marketCase).to.deep.include({ userId: marketLawyerId, copiedFromCaseId: caseId });

    // The invite lost the race: its own lock+recheck, run after the marketplace engagement already
    // committed, found that different, already-ENGAGED request and aborted — no second ClientRequest
    // for the invite lawyer, and its own seeded Case was cleaned up rather than left orphaned.
    expect(result).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
    expect(await prisma.clientRequest.count({ where: { caseId, requestedLawyerId: inviteLawyerId } })).to.equal(0);
    const inviteRow = await CaseLawyerInviteRepo.findByToken(invite.token);
    expect(inviteRow?.status).to.equal("PENDING");
    // Exactly one lawyer-owned Case descends from the client's case: the marketplace engagement's.
    // Phrased as counts, not "which specific side won", so this doesn't depend on which of two
    // ENGAGED rows a plain findFirst happens to return first (the bug the exclusion fix closes).
    expect(await prisma.clientRequest.count({ where: { caseId, status: "ENGAGED" } })).to.equal(1);
    expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(1);
  });

  // The final review's C2. This test used to set a CONFIRMED marketplace request up, redeem the
  // invite past it, and assert two ENGAGED requests on the case as the expected outcome — the bug
  // itself, encoded as a requirement. An open marketplace request (here CONFIRMED: the client
  // accepted the quote but hasn't paid) now blocks the invite outright, so when the client then pays,
  // the case ends with exactly one ENGAGED request and one lawyer, never two.
  it("an invite redeemed while a marketplace request is still open is refused, so when the client then pays the case ends with exactly one ENGAGED request", async () => {
    const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
    const { marketRequest, marketClaim, quotation } = await marketplaceRequest("CONFIRMED", "PAID");

    // Ordinary sequential use, no race: the lawyer redeems first...
    const inviteResult = await CaseLawyerInviteSvc.redeem({ id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com` }, invite.token);
    expect(inviteResult).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
    expect(await prisma.clientRequest.count({ where: { caseId, requestedLawyerId: inviteLawyerId } })).to.equal(0);
    expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(0);
    expect((await CaseLawyerInviteRepo.findByToken(invite.token))?.status).to.equal("PENDING");

    // ...then the client pays the marketplace quote (QuotationPaymentRepo.settle flips it ENGAGED)
    // and the real afterEngaged seeds that lawyer their Case, unopposed.
    await prisma.clientRequest.update({ where: { id: marketRequest.id }, data: { status: "ENGAGED", engagedAt: new Date() } });
    await prisma.clientRequestClaim.update({ where: { id: marketClaim.id }, data: { outcome: "ENGAGED" } });
    await QuotationPaymentSvc.afterEngaged(quotation, { organizationId: null, lawyerId: marketLawyerId }, 0, null, "GBP");

    expect(await prisma.clientRequest.count({ where: { caseId, status: "ENGAGED" } })).to.equal(1);
    const marketClaimAfter = await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: marketClaim.id } });
    expect(marketClaimAfter.lawyerCaseId).to.be.a("string");
    expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(1);
    const marketCase = await prisma.case.findUniqueOrThrow({ where: { id: marketClaimAfter.lawyerCaseId! } });
    expect(marketCase).to.deep.include({ userId: marketLawyerId, copiedFromCaseId: caseId });

    // And a redeem retried after the engagement is still refused: the case has its lawyer.
    const retried = await CaseLawyerInviteSvc.redeem({ id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com` }, invite.token);
    expect(retried).to.deep.equal({ error: "CASE_ALREADY_HAS_LAWYER" });
    expect(await prisma.clientRequest.count({ where: { caseId, status: "ENGAGED" } })).to.equal(1);
  });

  it("the invite wins a genuine race: it engages first, so the marketplace engagement's own lock+recheck (Task 10) catches the conflict and skips seeding", async () => {
    // Only reachable now as a true concurrent race: the marketplace request appears while the
    // marketplace path's seed() is in flight *after* the invite already engaged (in ordinary use
    // the invite's ENGAGED request makes ClientRequestSvc refuse a new one with REQUEST_ALREADY_OPEN,
    // and the test above shows the other order refused at redeem). This keeps proving Task 10's
    // seed-side lock and recheck still decide who gets a seeded Case when both do engage —
    // the parked KNOWN LIMITATION in seedLawyerCase's doc comment.
    const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });
    const inviteResult = await CaseLawyerInviteSvc.redeem({ id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com` }, invite.token);
    expect((inviteResult as { error?: string }).error).to.equal(undefined);
    const inviteCaseId = (inviteResult as { caseId: string }).caseId;

    // The marketplace request that slipped in concurrently, already settled ENGAGED by its payment.
    const { marketClaim, quotation } = await marketplaceRequest("CONFIRMED", "PAID");
    await prisma.clientRequest.update({ where: { id: quotation.requestId }, data: { status: "ENGAGED", engagedAt: new Date() } });
    await prisma.clientRequestClaim.update({ where: { id: marketClaim.id }, data: { outcome: "ENGAGED" } });
    await QuotationPaymentSvc.afterEngaged(quotation, { organizationId: null, lawyerId: marketLawyerId }, 0, null, "GBP");

    const inviteCase = await prisma.case.findUniqueOrThrow({ where: { id: inviteCaseId } });
    expect(inviteCase).to.deep.include({ userId: inviteLawyerId, copiedFromCaseId: caseId });
    expect((await CaseLawyerInviteRepo.findByToken(invite.token))?.status).to.equal("ACCEPTED");
    // The marketplace engagement lost the seed: its claim's lawyerCaseId stays null and the Case
    // CaseSeedSvc.seed built for it was discarded, so exactly one seeded Case exists.
    expect((await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: marketClaim.id } })).lawyerCaseId).to.equal(null);
    expect(await prisma.clientRequestClaim.count({ where: { request: { caseId }, lawyerCaseId: { not: null } } })).to.equal(1);
    expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(1);
  });
});
