import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import WitnessRepo from "../repositories/witness.repository";
import DamageClaimRepo from "../repositories/damage-claim.repository";
import CaseTheoryRepo from "../repositories/case-theory.repository";
import MindMapRepo from "../repositories/mind-map.repository";
import { MindMapItem } from "../utils/response-parser";
import { StrategyLike } from "../utils/case-change-delta";

/** How the change summary reads a pane before and after a run — shared by the analysis refresh
 * (CaseRefreshSvc) and each pane's own Regenerate, so both compare the same thing. Each is
 * exactly what the matching diff in utils/case-change-delta.ts takes. */
const CaseChangeReads = {
  /** Case Strategy's plan and to-dos, and the timeline its step writes key dates onto. */
  async strategy(caseId: string): Promise<StrategyLike> {
    const [items, dates] = await Promise.all([ProceduralDeadlineRepo.listProcedureItems(caseId), CaseTimelineRepo.list(caseId)]);
    return { items, dates };
  },

  witnesses: (caseId: string) => WitnessRepo.list(caseId),

  damages: (caseId: string) => DamageClaimRepo.list(caseId),

  /** The case's one AI draft theory, with its claims, assumptions and open questions. */
  async theory(caseId: string) {
    const draft = await CaseTheoryRepo.findLatestAiDraft(caseId);
    return draft ? CaseTheoryRepo.findById(draft.id, caseId) : null;
  },

  /** The case map's tree — null before the first build, and for a retired map (the app hides it). */
  async mindMap(caseId: string): Promise<MindMapItem | null> {
    const map = await MindMapRepo.findCaseMap(caseId);
    return map && !map.retiredAt ? (map.data as unknown as MindMapItem) : null;
  },
};

export default CaseChangeReads;
