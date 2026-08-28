import CaseAccess from "../utils/case-access";
import CaseSnapshotSvc from "./case-snapshot.service";
import RedTeamRepo from "../repositories/red-team.repository";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { getRedTeamPromptBuilder } from "../legal/prompt-registry";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import logger from "../utils/logger";

// A real 4-section threat assessment (procedural attacks + 3-5 cross-exam questions +
// substantive vulnerabilities + damages analysis, each with citations) legitimately runs
// well past a few thousand words. The previous 16000-char cap cut a genuine response off
// mid-word; this one is generous enough that it should only ever bite runaway output.
const MAX_CONTENT_CHARS = 60000;

// If content still needs cutting, cut at the last paragraph break instead of mid-sentence,
// and say so — better than silently handing back an assessment that just stops mid-word.
function truncateGracefully(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n\n");
  const safe = lastBreak > max * 0.5 ? cut.slice(0, lastBreak) : cut;
  return `${safe}\n\n*(Response truncated — exceeded the display limit. Regenerate for a fresh attempt.)*`;
}

function cleanContent(text: string): string {
  const stripped = text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .trim();
  return truncateGracefully(stripped, MAX_CONTENT_CHARS);
}

export default class RedTeamSvc {
  static async get(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return RedTeamRepo.get(caseId);
  }

  /** Attacks the case's own structured findings (Legal Issues, Weaknesses, Contradictions,
   * Witnesses, Damages, Evidence & Timeline) rather than re-reading raw document text — the
   * prompt is built entirely from CaseSnapshotSvc.get(), matching "Zero Hallucination: base
   * attacks ONLY on the data provided in the prompt." No grounding/case-document-ids are
   * sent to Chat Wonder, so it can't reach past what's already been reviewed and entered. */
  static async generate(caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const snapshot = await CaseSnapshotSvc.get(caseId, userId);

    const buildRedTeamPrompt = getRedTeamPromptBuilder(tenantCode);
    const prompt = buildRedTeamPrompt({
      caseName: snapshot.case.caseName,
      actionType: snapshot.case.actionType,
      // Case.jurisdiction is the case's own free-text court/venue field — unrelated to the
      // tenantCode above (which only selects which PH/UK prompt template to render).
      jurisdiction: snapshot.case.jurisdiction,
      parties: snapshot.case.parties,
      legalIssues: snapshot.findings.filter((f) => f.category === "LEGAL_ISSUE").map((f) => f.label),
      weaknesses: snapshot.findings.filter((f) => f.category === "WEAKNESS").map((f) => f.label),
      documents: snapshot.documents.map((d) => ({ name: d.name })),
      timeline: snapshot.timeline.map((t) => ({ title: t.title, occurredOn: t.occurredOn })),
      contradictions: snapshot.evidence.contradictions.map((c) => ({
        kind: c.kind,
        leftValue: c.leftValue,
        rightValue: c.rightValue,
        leftExcerpt: c.leftExcerpt,
        rightExcerpt: c.rightExcerpt,
      })),
      witnesses: snapshot.witnesses.map((w) => ({ name: w.name, role: w.role })),
      damages: snapshot.damages.map((d) => ({ category: d.category, description: d.description, amount: d.amount })),
    });

    // A single blocking REST call (callChatWonderRest) waits for the entire response before
    // returning — a real 4-section threat assessment routinely takes long enough to generate
    // that Cloudflare's edge proxy (in front of Chat Wonder) times the connection out (524)
    // before it finishes, independent of any timeout set in this app's own HTTP client. The
    // streaming WS path avoids that: it's how the interactive Chat feature already handles
    // AI responses that might take a while.
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {});
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {});
    }

    const content = cleanContent(result.content);
    logger.info("Chat Wonder red team assessment reply", { caseId, contentChars: content.length });
    if (!content) throw new HttpError("Chat Wonder returned no assessment text", 502);

    const row = await RedTeamRepo.upsert(caseId, content);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "redTeam.generate", payload: { id: row.id } });
    return row;
  }
}
