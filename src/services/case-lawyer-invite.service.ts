import crypto from "crypto";
import { Prisma, type CaseLawyerInviteStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import CaseLawyerInviteRepo from "../repositories/case-lawyer-invite.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import FilesRepo from "../repositories/files.repository";
import CaseSeedSvc from "./case-seed.service";
import NotificationSvc from "./notification.service";
import { normalizeEmail } from "../utils/auth.utils";
import { CASE_LAWYER_INVITE_EXPIRY_MS } from "../constants/case-lawyer-invite.constants";
import logger from "../utils/logger";

/** `redeem`'s consent-capture fields on the ClientRequest it creates: this is a client inviting
 * their own named lawyer, not the marketplace consent flow, so it gets its own fixed version
 * string rather than reusing CLIENT_REQUEST_CONSENT_VERSION. */
const OWN_LAWYER_INVITE_CONSENT_VERSION = "own-lawyer-invite-1";

export type RedeemResult =
  | { requestId: string; caseId: string }
  | { error: "INVITE_NOT_FOUND" | "INVITE_ALREADY_USED" | "INVITE_EXPIRED" | "INVITE_EMAIL_MISMATCH" | "CASE_ALREADY_HAS_LAWYER" | "CASE_NOT_FOUND" };

/** The invite as the client app reads it (InviteStatusDto in the contract): just enough to show
 * where it stands, never the token (that's only ever handed back once, at creation). */
export interface InviteStatusDto {
  status: CaseLawyerInviteStatus;
  email: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

/** What the public signup page shows about an invite. Deliberately narrow: no case details beyond its
 * name, no client surname, never the token. */
export interface SignupLookupDto {
  status: "valid" | "expired" | "revoked" | "accepted";
  clientFirstName: string;
  caseName: string;
  email: string | null;
}

const SIGNUP_STATUS: Record<CaseLawyerInviteStatus, SignupLookupDto["status"]> = {
  PENDING: "valid",
  ACCEPTED: "accepted",
  REVOKED: "revoked",
  EXPIRED: "expired",
};

/** Sends the lawyer their invite email. A no-op for now — Task 9 replaces this with the real send
 * (the link/email invite content and delivery aren't this task's job). */
async function sendInviteEmail(_invite: { token: string; email: string }): Promise<void> {}

/**
 * A client inviting their own lawyer onto a case (client-invites-own-lawyer): a link or email
 * invite, superseding any still-pending one on the case, so a case ever has at most one live
 * invite. Blocked once the case already has an ENGAGED lawyer through the marketplace flow.
 */
export default class CaseLawyerInviteSvc {
  /** A shareable link invite: the client sends the token themselves. */
  static async createLinkInvite(clientId: string, caseId: string): Promise<{ token: string; expiresAt: Date }> {
    return CaseLawyerInviteSvc.createInvite(clientId, caseId, null);
  }

  /** An invite emailed straight to the lawyer. Email delivery is stubbed (sendInviteEmail) until
   * Task 9 wires it up. */
  static async createEmailInvite(clientId: string, caseId: string, email: string): Promise<{ token: string; expiresAt: Date }> {
    const invite = await CaseLawyerInviteSvc.createInvite(clientId, caseId, email);
    await sendInviteEmail({ token: invite.token, email });
    return invite;
  }

  /** Revokes any pending invite on the case and creates the new one in its place, in one
   * transaction, so the case never has two live invites even if this races. */
  private static async createInvite(clientId: string, caseId: string, email: string | null): Promise<{ token: string; expiresAt: Date }> {
    await CaseLawyerInviteSvc.assertOwnsCase(clientId, caseId);
    await CaseLawyerInviteSvc.assertNoLiveLawyer(caseId);
    const invite = await prisma.$transaction(async (tx) => {
      await CaseLawyerInviteRepo.revokePendingForCase(caseId, tx);
      return CaseLawyerInviteRepo.create({ caseId, clientId, email, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + CASE_LAWYER_INVITE_EXPIRY_MS) }, tx);
    });
    return { token: invite.token, expiresAt: invite.expiresAt };
  }

  /** The case's current invite, however it stands — null once there's never been one, or the only
   * one has been revoked, accepted or expired (findPendingForCase only sees PENDING rows; showing
   * the client their invite's outcome once it's no longer pending is a gap left for later). */
  static async getCurrentForCase(clientId: string, caseId: string): Promise<InviteStatusDto | null> {
    await CaseLawyerInviteSvc.assertOwnsCase(clientId, caseId);
    const invite = await CaseLawyerInviteRepo.findPendingForCase(caseId);
    if (!invite) return null;
    return { status: invite.status, email: invite.email, expiresAt: invite.expiresAt, acceptedAt: invite.acceptedAt, revokedAt: invite.revokedAt };
  }

  /** Public, unauthenticated: resolves an invite token for the signup page. A PENDING invite past its
   * expiry is marked EXPIRED on read (lazy expiry) and reported as "expired". Never redeems the invite. */
  static async lookupForSignup(token: string): Promise<SignupLookupDto> {
    const invite = await CaseLawyerInviteRepo.findByToken(token);
    if (!invite) throw new HttpError("Invite not found.", 404, "INVITE_NOT_FOUND");

    let status: CaseLawyerInviteStatus = invite.status;
    if (invite.status === "PENDING" && invite.expiresAt < new Date()) {
      await CaseLawyerInviteRepo.markExpired(invite.id);
      status = "EXPIRED";
    }

    const [client, kase] = await Promise.all([
      prisma.user.findUnique({ where: { id: invite.clientId }, select: { name: true, username: true } }),
      prisma.case.findUnique({ where: { id: invite.caseId }, select: { caseName: true } }),
    ]);
    // The invite points at a client or case that's gone: from the public caller's side that's the
    // same as a token that doesn't exist, so it gets the same clean 404 rather than a 500.
    if (!client || !kase) throw new HttpError("Invite not found.", 404, "INVITE_NOT_FOUND");
    // There's no stored first-name field on User: this is a best-effort split of the full `name`,
    // falling back to `username` when `name` is empty or null.
    const clientFirstName = (client.name ?? "").trim().split(/\s+/)[0] || client.username;

    return { status: SIGNUP_STATUS[status], clientFirstName, caseName: kase.caseName, email: invite.email };
  }

  /**
   * The lawyer redeeming their invite token, right after signing up/in (Task 8 calls this from the
   * auth flow): attaches them to the case for real — a fresh, lawyer-owned Case seeded from the
   * client's (CaseSeedSvc.seed), and an ENGAGED ClientRequest+ClientRequestClaim so the rest of the
   * platform (billing exemptions, `findEngagedLawyerForCase`, the client's case page) sees this
   * exactly like a marketplace engagement. Never throws for any of the listed outcomes — Task 8's
   * caller must be able to treat a bad or stale invite as "nothing to attach" and carry on.
   *
   * Transaction-nesting note: `CaseSeedSvc.seed` opens its own `prisma.$transaction` (and makes
   * network calls to S3 before that), so it can't run inside this method's own transaction — Prisma
   * doesn't support composing two separate `$transaction` calls into one atomic unit, and even if it
   * did, holding a transaction open across S3 round-trips would be its own problem (seed's own
   * comments make the same call for its own writes). So `seed()` runs first, as its own atomic unit,
   * and only once it has succeeded does this method open its own transaction to create the
   * ClientRequest/Claim (with `lawyerCaseId` already known) and mark the invite ACCEPTED (guarded,
   * so a race that already consumed the invite rolls this transaction back). The one failure window
   * this leaves: if this method's own transaction fails *after* `seed()` already committed a new
   * Case, that Case is orphaned — lawyer-owned, not referenced by any ClientRequest, otherwise
   * harmless and cleanable. The alternative (create the ClientRequest first, seed second) was worse:
   * it risks a live ENGAGED request with no case behind it, which every other read of "is this case
   * attached" would trip over.
   */
  static async redeem(user: { id: string; email: string }, token: string): Promise<RedeemResult> {
    const invite = await CaseLawyerInviteRepo.findByToken(token);
    if (!invite) return { error: "INVITE_NOT_FOUND" };

    if (invite.status !== "PENDING") return { error: "INVITE_ALREADY_USED" };
    if (invite.expiresAt < new Date()) {
      await CaseLawyerInviteRepo.markExpired(invite.id);
      return { error: "INVITE_EXPIRED" };
    }

    if (invite.email && normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
      return { error: "INVITE_EMAIL_MISMATCH" };
    }

    const engaged = await ClientRequestRepo.findEngagedLawyerForCase(invite.caseId);
    if (engaged) return { error: "CASE_ALREADY_HAS_LAWYER" };

    // CaseSeedSvc.seed does no validation of the source case at all (by design — that's this
    // method's job): a case that's gone, or archived out from under a live invite, isn't a valid
    // seed source. ARCHIVED is the only other status Case has (CaseStatus); treat it the same as
    // deleted, since an archived case is one the client has put away, not one to attach a lawyer to.
    const sourceCase = await prisma.case.findUnique({ where: { id: invite.caseId }, select: { id: true, status: true } });
    if (!sourceCase || sourceCase.status !== "ACTIVE") return { error: "CASE_NOT_FOUND" };

    const seeded = await CaseSeedSvc.seed({ sourceCaseId: invite.caseId, lawyerId: user.id, organizationId: null });

    const result = await prisma.$transaction(async (tx) => {
      const marked = await CaseLawyerInviteRepo.markAccepted(invite.id, user.id, tx);
      if (marked.count === 0) {
        // Lost a race (accepted, revoked or lazily expired since the checks above, in the time
        // seed()'s S3 copies took): abort before writing anything else.
        throw new HttpError("Invite already used.", 409, "INVITE_ALREADY_USED");
      }

      // Lock the source case's row for the rest of this transaction, then repeat the
      // live-ENGAGED check through it: the pre-seed check above only ran once, before seed()'s
      // (possibly slow) S3 copies, so a second invite on the same case — or a marketplace
      // engagement reaching ENGAGED in the meantime — could otherwise slip an ENGAGED
      // ClientRequest past it and in underneath this one. The lock serializes any other writer
      // doing the same check against this case: whichever of two concurrent redeems gets here
      // first holds the row until it commits or rolls back, so the second one's recheck (run only
      // after it acquires the same lock) is guaranteed to see the first one's write once it's
      // allowed to proceed.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Case" WHERE id = ${invite.caseId} FOR UPDATE`);
      const stillUnengaged = await ClientRequestRepo.findEngagedLawyerForCase(invite.caseId, tx);
      if (stillUnengaged) throw new HttpError("This case already has a lawyer.", 409, "CASE_ALREADY_HAS_LAWYER");

      const request = await tx.clientRequest.create({
        data: {
          caseId: invite.caseId,
          clientId: invite.clientId,
          status: "ENGAGED",
          note: "",
          consentVersion: OWN_LAWYER_INVITE_CONSENT_VERSION,
          consentAcceptedAt: invite.createdAt,
          requestedLawyerId: user.id,
          requestedOnly: true,
          engagedAt: new Date(),
        },
      });

      await tx.clientRequestClaim.create({
        data: {
          requestId: request.id,
          lawyerId: user.id,
          organizationId: null,
          claimedAt: new Date(),
          expiresAt: new Date(),
          outcome: "ENGAGED",
          lawyerCaseId: seeded.caseId,
        },
      });

      return { requestId: request.id, caseId: seeded.caseId };
    }).catch((err) => {
      if (err instanceof HttpError && err.code === "INVITE_ALREADY_USED") return { error: "INVITE_ALREADY_USED" as const };
      if (err instanceof HttpError && err.code === "CASE_ALREADY_HAS_LAWYER") return { error: "CASE_ALREADY_HAS_LAWYER" as const };
      throw err;
    });

    if ("error" in result) {
      // The transaction above rolled back, so seed()'s Case (and its copied Document/File rows)
      // never got a ClientRequest pointing at it — clean it up rather than leaving a full copy of
      // the client's case and documents orphaned (a real privacy concern: e.g. the client revokes
      // the invite while this redeem is mid-flight, the lawyer loses the race, but would otherwise
      // keep a copy of the case forever with nothing accounting for it).
      await CaseLawyerInviteSvc.cleanupOrphanedSeed(seeded.caseId);
      return result;
    }

    await NotificationSvc.create({
      userId: invite.clientId,
      type: "CASE_UPDATE",
      title: "Your lawyer has joined ilovelawyer",
      message: "Your lawyer has joined ilovelawyer and can now see your case.",
      link: `/cases/${invite.caseId}`,
    }).catch((err) => logger.error("CaseLawyerInviteSvc.redeem: failed to notify client", { err, caseId: invite.caseId }));
    await NotificationSvc.create({
      userId: user.id,
      type: "CASE_UPDATE",
      title: "You're attached to your client's case",
      message: "You've joined your client's case through their invite and can now see it.",
      link: `/cases/${result.caseId}`,
    }).catch((err) => logger.error("CaseLawyerInviteSvc.redeem: failed to notify lawyer", { err, lawyerId: user.id }));

    return result;
  }

  /**
   * Best-effort removal of a Case that `CaseSeedSvc.seed` finished seeding but that `redeem`'s own
   * transaction then rolled back on top of (a lost `markAccepted` race, or the in-transaction
   * CASE_ALREADY_HAS_LAWYER recheck) — so no ClientRequest ever ends up pointing at it. Deletes the
   * seeded Case's Document rows directly (cheaper than DocumentSvc.delete's per-document audit-log
   * path, which also assumes a real actor/workspace context this cleanup doesn't have), marks each
   * Document's File FOR_DELETION once orphaned (the existing sweep-job convention — see
   * FilesRepo.markForDeletionIfOrphaned and DocumentSvc.delete, which does the same), then deletes
   * the Case row itself. Never throws: a failure here must not mask or replace the real error
   * `redeem` is already returning, so it's only ever logged.
   */
  private static async cleanupOrphanedSeed(caseId: string): Promise<void> {
    try {
      const docs = await prisma.document.findMany({ where: { caseId }, select: { id: true, fileId: true } });
      await prisma.document.deleteMany({ where: { caseId } });
      for (const doc of docs) {
        if (doc.fileId) await FilesRepo.markForDeletionIfOrphaned(doc.fileId);
      }
      await prisma.case.delete({ where: { id: caseId } });
    } catch (err) {
      logger.error("CaseLawyerInviteSvc.redeem: failed to clean up an orphaned seeded case", { err, caseId });
    }
  }

  /** Revokes the case's pending invite. 404 INVITE_NOT_FOUND when there was none to revoke. */
  static async revoke(clientId: string, caseId: string): Promise<void> {
    await CaseLawyerInviteSvc.assertOwnsCase(clientId, caseId);
    const pending = await CaseLawyerInviteRepo.findPendingForCase(caseId);
    if (!pending) throw new HttpError("There's no pending invite to revoke.", 404, "INVITE_NOT_FOUND");
    await CaseLawyerInviteRepo.revokePendingForCase(caseId);
  }

  /** 404 when the case isn't the client's own (matches ClientRequestSvc/ClientCaseSvc's "Case not
   * found" convention for a client reaching for a case that isn't theirs). */
  private static async assertOwnsCase(clientId: string, caseId: string): Promise<void> {
    const row = await prisma.case.findFirst({ where: { id: caseId, userId: clientId }, select: { id: true } });
    if (!row) throw new HttpError("Case not found", 404);
  }

  /** 409 CASE_HAS_LAWYER when the case already has a lawyer engaged on it through the marketplace
   * flow (ClientRequestRepo.findEngagedLawyerForCase — the same "is anyone live on this case"
   * check the marketplace flow itself relies on). */
  private static async assertNoLiveLawyer(caseId: string): Promise<void> {
    const engaged = await ClientRequestRepo.findEngagedLawyerForCase(caseId);
    if (engaged) throw new HttpError("This case already has a lawyer. End that engagement before inviting another.", 409, "CASE_HAS_LAWYER");
  }
}
