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
import CaseCopySvc from "./case-copy.service";
import { TRIAL_CASE_INTRO_ANSWER, TRIAL_CASE_INTRO_QUESTION, TRIAL_CASE_INTRO_TITLE } from "../constants/trial-sample-case.constants";
import { ACCESS_TOKEN_SECRET, TRIAL_DURATION_MS, TRIAL_SAMPLE_CASE_ID } from "../config";
import type { TenantCode } from "../types/tenant-code";
import { TRIAL_SAMPLE_ANSWER, TRIAL_SAMPLE_QUESTION, TRIAL_SAMPLE_RELATED_CASES, TRIAL_SAMPLE_TITLE } from "../constants/trial-sample.constants";

export default class TrialSvc {
  /** The landing page's "Start a consultation" for someone with no account: a throwaway guest in
   * its own personal UK workspace, signed in like any other user so every existing chat route
   * works unchanged. What makes it a trial is User.trialExpiresAt: a session that ends with it,
   * a cap on AI answers (trialMessageLimit) and no uploads or sharing (blockTrialWrites). The
   * caller has shown the guest the AI-processing notice; their acceptance is recorded as consent. */
  static async start(requestTenantCode: TenantCode | null, sample: "consultation" | "case" = "consultation") {
    if (requestTenantCode !== "UK") throw new HttpError("The trial is not available here", 404);
    if (sample === "case" && !TRIAL_SAMPLE_CASE_ID) throw new HttpError("The sample case is not available", 404);
    const tenantId = await TenantRepo.findIdByCode("UK");
    if (!tenantId) throw new HttpError('No Tenant seeded for code "UK"', 500);

    const id = crypto.randomUUID();
    const tag = id.slice(0, 8);
    const trialExpiresAt = new Date(Date.now() + TRIAL_DURATION_MS);
    await AuthRepo.createTrialUser({ id, username: `guest.${tag}`, email: `trial-${id}@trial.invalid`, tenantId, trialExpiresAt });
    const workspace = await OrganizationSvc.create(id, `Guest ${tag}`, undefined, "UK", true);
    await ConsentSvc.set(id, "AI_PROCESSING", true, "trial");
    const consultationId = await TrialSvc.seedSampleConsultation(id);
    // "Explore a sample case file": the guest gets their own copy of the sample case, documents
    // already indexed, alongside the sample consultation.
    const caseId =
      sample === "case"
        ? await CaseCopySvc.copy({
            sourceCaseId: TRIAL_SAMPLE_CASE_ID,
            userId: id,
            targetOrganizationId: workspace.id,
            sourceOrganizationName: "ilovelawyer",
            reuseIndex: true,
          })
        : null;
    // ...opening on a "Start here" note that says what the case is and what to ask.
    const caseConsultationId = caseId ? await TrialSvc.seedCaseIntro(id, workspace.id, caseId) : null;

    // Signed to stop with the trial, not at the usual access-token lifetime.
    const { refreshToken } = loginToken(id, false);
    const accessToken = jwt.sign({ userId: id }, ACCESS_TOKEN_SECRET, { expiresIn: Math.floor(TRIAL_DURATION_MS / 1000) });
    await AuthRepo.createSession(id, refreshToken, trialExpiresAt);
    await SecurityAuditSvc.record({ action: "auth.signup", actorId: id, payload: { method: "trial" } });

    return { user: await AuthRepo.findById(id), accessToken, refreshToken, consultationId, caseId, caseConsultationId };
  }

  /** Deletes every trial guest whose trial ended before `now`, with everything they had: first
   * their own workspace (its cases, chats, documents — the sample case copy included — through
   * OrganizationRepo.deletePermanently, which also marks the files for the S3 sweep), then the
   * user itself (AccountDeletionSvc.purge). Only a personal workspace whose sole member is the
   * guest is touched. Run by TrialGuestPurgeQueue and scripts/purge-trial-users. Returns how many
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

  /** The sample case's first consultation: a finished, hand-written "what is this case" question
   * and answer (no AI, not counted), created last so the case opens on it. */
  private static async seedCaseIntro(userId: string, organizationId: string, caseId: string): Promise<string> {
    const consultation = await ChatRepo.createConsultation(organizationId, userId, TRIAL_CASE_INTRO_TITLE, caseId);
    const question = await ChatRepo.createMessage(consultation.id, "user", TRIAL_CASE_INTRO_QUESTION, userId, undefined, undefined, undefined, undefined, "DONE");
    await ChatRepo.createMessage(consultation.id, "assistant", TRIAL_CASE_INTRO_ANSWER, undefined, question.id);
    return consultation.id;
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
