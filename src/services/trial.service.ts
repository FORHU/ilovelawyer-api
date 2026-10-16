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
import { ACCESS_TOKEN_SECRET } from "../config";
import type { TenantCode } from "../types/tenant-code";
import { TRIAL_DURATION_MS } from "../constants/trial.constants";
import { TRIAL_SAMPLE_ANSWER, TRIAL_SAMPLE_QUESTION, TRIAL_SAMPLE_RELATED_CASES, TRIAL_SAMPLE_TITLE } from "../constants/trial-sample.constants";

export default class TrialSvc {
  /** The landing page's "Start a consultation" for someone with no account: a throwaway guest in
   * its own personal UK workspace, signed in like any other user so every existing chat route
   * works unchanged. What makes it a trial is User.trialExpiresAt: a session that ends with it,
   * a cap on AI answers (trialMessageLimit) and no uploads or sharing (blockTrialWrites). The
   * caller has shown the guest the AI-processing notice; their acceptance is recorded as consent. */
  static async start(requestTenantCode: TenantCode | null) {
    if (requestTenantCode !== "UK") throw new HttpError("The trial is not available here", 404);
    const tenantId = await TenantRepo.findIdByCode("UK");
    if (!tenantId) throw new HttpError('No Tenant seeded for code "UK"', 500);

    const id = crypto.randomUUID();
    const tag = id.slice(0, 8);
    const trialExpiresAt = new Date(Date.now() + TRIAL_DURATION_MS);
    await AuthRepo.createTrialUser({ id, username: `guest.${tag}`, email: `trial-${id}@trial.invalid`, tenantId, trialExpiresAt });
    await OrganizationSvc.create(id, `Guest ${tag}`, undefined, "UK", true);
    await ConsentSvc.set(id, "AI_PROCESSING", true, "trial");
    const consultationId = await TrialSvc.seedSampleConsultation(id);

    // Signed to stop with the trial, not at the usual access-token lifetime.
    const { refreshToken } = loginToken(id, false);
    const accessToken = jwt.sign({ userId: id }, ACCESS_TOKEN_SECRET, { expiresIn: Math.floor(TRIAL_DURATION_MS / 1000) });
    await AuthRepo.createSession(id, refreshToken, trialExpiresAt);
    await SecurityAuditSvc.record({ action: "auth.signup", actorId: id, payload: { method: "trial" } });

    return { user: await AuthRepo.findById(id), accessToken, refreshToken, consultationId };
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
