import crypto from "crypto";
import jwt from "jsonwebtoken";
import AuthRepo from "../repositories/auth.repository";
import ChatRepo from "../repositories/chat.repository";
import TenantRepo from "../repositories/tenant.repository";
import OrganizationSvc from "./organization.service";
import ConsentSvc from "./consent.service";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import loginToken from "../utils/loginToken";
import { OrganizationStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import OrganizationRepo from "../repositories/organization.repository";
import AccountDeletionSvc from "./account-deletion.service";
import type { TrialKind } from "@prisma/client";
import { ACCESS_TOKEN_SECRET, REFRESH_TOKEN_EXPIRY_DAYS, TRIAL_BUDGET_USD, TRIAL_DURATION_MS } from "../config";
import type { TenantCode } from "../types/tenant-code";
import { TRIAL_SAMPLE_ANSWER, TRIAL_SAMPLE_QUESTION, TRIAL_SAMPLE_RELATED_CASES, TRIAL_SAMPLE_TITLE } from "../constants/trial-sample.constants";

export default class TrialSvc {
  /** The landing page's trial for someone with no account: a throwaway guest in its own personal UK
   * workspace, signed in like any other user so every existing route works unchanged. User.trialKind
   * makes it a trial, of one of two kinds:
   *  - CHAT: a session that ends at trialExpiresAt, a cap on AI answers (trialMessageLimit) and no
   *    writes beyond chatting (blockTrialWrites).
   *  - FULL: the whole product, their own cases included, with no end date and nothing blocked. The
   *    only limit is TRIAL_BUDGET_USD of OpenAI usage through Chat Wonder (trialBudgetSpent).
   * The caller has shown the guest the AI-processing notice; their acceptance is recorded as consent. */
  static async start(requestTenantCode: TenantCode | null, kind: TrialKind = "CHAT") {
    if (requestTenantCode !== "UK") throw new HttpError("The trial is not available here", 404);
    if (kind === "FULL" && TRIAL_BUDGET_USD === null) throw new HttpError("The full trial is not available", 404);
    const tenantId = await TenantRepo.findIdByCode("UK");
    if (!tenantId) throw new HttpError('No Tenant seeded for code "UK"', 500);

    const id = crypto.randomUUID();
    const tag = id.slice(0, 8);
    const trialExpiresAt = kind === "CHAT" ? new Date(Date.now() + TRIAL_DURATION_MS) : null;
    await AuthRepo.createTrialUser({ id, username: `guest.${tag}`, email: `trial-${id}@trial.invalid`, tenantId, trialKind: kind, trialExpiresAt });
    await OrganizationSvc.create(id, `Guest ${tag}`, undefined, "UK", true);
    await ConsentSvc.set(id, "AI_PROCESSING", true, "trial");
    const consultationId = await TrialSvc.seedSampleConsultation(id);

    // A CHAT guest's tokens are signed to stop with the trial, not at the usual access-token
    // lifetime. A FULL guest has no end date, so it gets the same session as a real sign-in.
    const tokens = loginToken(id, false);
    const { refreshToken } = tokens;
    const accessToken = trialExpiresAt
      ? jwt.sign({ userId: id }, ACCESS_TOKEN_SECRET, { expiresIn: Math.floor(TRIAL_DURATION_MS / 1000) })
      : tokens.accessToken;
    await AuthRepo.createSession(id, refreshToken, trialExpiresAt ?? new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000));
    await SecurityAuditSvc.record({ action: "auth.signup", actorId: id, payload: { method: "trial", kind } });

    return { user: await AuthRepo.findById(id), accessToken, refreshToken, consultationId };
  }

  /** Deletes every trial guest whose trial ended before `now`, with everything they had: first
   * their own workspace (its cases, chats, documents — through OrganizationRepo.deletePermanently,
   * which also marks the files FOR_DELETION), then the user itself (AccountDeletionSvc.purge). Only
   * a personal workspace whose sole member is the guest is touched, and only CHAT guests have a
   * trial end. Run by hand through scripts/purge-trial-users. Returns how many
   * guests were deleted. */
  static async purgeExpired(now: Date = new Date()): Promise<number> {
    const expired = await prisma.user.findMany({ where: { trialExpiresAt: { lt: now } }, select: { id: true } });
    for (const { id } of expired) {
      const workspaces = await prisma.organization.findMany({
        where: { isPersonal: true, members: { some: { userId: id }, every: { userId: id } } },
        select: { id: true },
      });
      for (const workspace of workspaces) {
        // deletePermanently only deletes an organization that is PENDING_DELETION.
        await prisma.organization.update({ where: { id: workspace.id }, data: { status: OrganizationStatus.PENDING_DELETION } });
        await OrganizationRepo.deletePermanently(workspace.id);
      }
      await AccountDeletionSvc.purge(id);
    }
    return expired.length;
  }

  /** The guest's first consultation: a finished sample question and answer with its related
   * cases, so the chat opens on what a real answer looks like. Standalone, like any main one. */
  private static async seedSampleConsultation(userId: string): Promise<string> {
    const consultation = await ChatRepo.createConsultation(null, userId, TRIAL_SAMPLE_TITLE);
    const question = await ChatRepo.createMessage(consultation.id, "user", TRIAL_SAMPLE_QUESTION, userId, undefined, undefined, undefined, undefined, "DONE");
    const answer = await ChatRepo.createMessage(consultation.id, "assistant", TRIAL_SAMPLE_ANSWER, undefined, question.id);
    await ChatRepo.saveRelatedCases(answer.id, TRIAL_SAMPLE_RELATED_CASES);
    return consultation.id;
  }
}
