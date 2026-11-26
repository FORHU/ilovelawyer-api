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
    await prisma.user.create({ data: { id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com`, username: `race-invite-lawyer-${inviteLawyerId}` } });
    await prisma.user.create({ data: { id: marketLawyerId, email: `race-market-lawyer-${marketLawyerId}@example.com`, username: `race-market-lawyer-${marketLawyerId}` } });
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

  it("the marketplace engagement wins: it lands first, so the invite's own lock+recheck (Task 7) catches the conflict and aborts", async () => {
    const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

    // The marketplace side's own ClientRequest+Claim+Quotation, still CONFIRMED/unquoted-outcome:
    // the race is in flipping these to ENGAGED (what QuotationPaymentRepo.settle's own transaction
    // would do) while the invite's seed() is in flight, then calling the real afterEngaged.
    const marketRequest = await prisma.clientRequest.create({
      data: { caseId, clientId, status: "CONFIRMED", consentVersion: "v1", consentAcceptedAt: new Date() },
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
        status: "ACCEPTED",
      },
    });

    const originalSeed = CaseSeedSvc.seed;
    let marketplaceSeededCaseId: string | undefined;
    let triggered = false;
    // While the invite redemption's own seed() (the slow, shared step) is in flight, the
    // marketplace payment settles (flips its request+claim ENGAGED, as QuotationPaymentRepo.settle
    // would) and runs the real afterEngaged — which takes the identical Case-row lock and, finding
    // no competing ENGAGED request yet (the invite hasn't created its ClientRequest yet; that only
    // happens after seed() returns), seeds and records its own Case normally. Guarded by `triggered`
    // so afterEngaged's own nested seed() call (for the marketplace Case itself) doesn't recurse.
    CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
      if (!triggered) {
        triggered = true;
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
    expect(await prisma.case.count({ where: { copiedFromCaseId: caseId } })).to.equal(1);
  });

  it("the invite wins: it lands first, so the marketplace engagement's own lock+recheck (Task 10) catches the conflict and skips seeding", async () => {
    const invite = await CaseLawyerInviteRepo.create({ caseId, clientId, token: makeToken(), expiresAt: future });

    // The marketplace side's own ClientRequest+Claim+Quotation, still CONFIRMED/unquoted-outcome: the
    // invite's own precheck (below) must see no live engagement yet, exactly as it would if the
    // client's payment hadn't settled yet either.
    const marketRequest = await prisma.clientRequest.create({
      data: { caseId, clientId, status: "CONFIRMED", consentVersion: "v1", consentAcceptedAt: new Date() },
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
        status: "PAID",
      },
    });

    const originalSeed = CaseSeedSvc.seed;
    let inviteResult: unknown;
    let triggered = false;
    // While the marketplace engagement's own seed() (afterEngaged's seedLawyerCase, called directly
    // below) is in flight, the invite redemption runs to completion for real — its own lock+recheck
    // (Task 7) sees no competing ENGAGED request yet (the marketplace payment hasn't been recorded as
    // ENGAGED yet either) and commits normally. Only once the invite's done does the marketplace
    // request+claim flip ENGAGED (as QuotationPaymentRepo.settle's own transaction already would have
    // by the time afterEngaged runs for real) and control returns to seedLawyerCase's own lock+recheck.
    // Guarded by `triggered` so the invite's own nested seed() call doesn't recurse back into this.
    CaseSeedSvc.seed = (async (input: Parameters<typeof CaseSeedSvc.seed>[0]) => {
      if (!triggered) {
        triggered = true;
        inviteResult = await CaseLawyerInviteSvc.redeem({ id: inviteLawyerId, email: `race-invite-lawyer-${inviteLawyerId}@example.com` }, invite.token);
        await prisma.clientRequest.update({ where: { id: marketRequest.id }, data: { status: "ENGAGED", engagedAt: new Date() } });
        await prisma.clientRequestClaim.update({ where: { id: marketClaim.id }, data: { outcome: "ENGAGED" } });
      }
      return originalSeed(input);
    }) as typeof CaseSeedSvc.seed;

    try {
      await QuotationPaymentSvc.afterEngaged(quotation, { organizationId: null, lawyerId: marketLawyerId }, 0, null, "GBP");
    } finally {
      CaseSeedSvc.seed = originalSeed;
    }

    // The invite won: it ran to completion while the marketplace engagement's seed() was in flight,
    // and its own lock+recheck found nothing in its way.
    expect((inviteResult as { error?: string } | undefined)?.error).to.equal(undefined);
    const inviteCaseId = (inviteResult as { caseId: string }).caseId;
    const inviteCase = await prisma.case.findUniqueOrThrow({ where: { id: inviteCaseId } });
    expect(inviteCase).to.deep.include({ userId: inviteLawyerId, copiedFromCaseId: caseId });
    const inviteRow = await CaseLawyerInviteRepo.findByToken(invite.token);
    expect(inviteRow?.status).to.equal("ACCEPTED");

    // The marketplace engagement lost: Task 10's own lock+recheck in seedLawyerCase, run after the
    // invite already committed, found that different, already-ENGAGED request and skipped seeding —
    // its claim's lawyerCaseId stays null rather than pointing at a Case nothing else accounts for.
    const marketClaimAfter = await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: marketClaim.id } });
    expect(marketClaimAfter.lawyerCaseId).to.equal(null);
  });
});
