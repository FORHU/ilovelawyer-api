import WitnessRepo, { WitnessInput } from "../repositories/witness.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import CaseGraphSvc from "./case-graph.service";
import DocumentRepo from "../repositories/document.repository";
import { mergeNeedsDone, parseNeedsDone, type NeedDone, type NeedDoneInput } from "../utils/witness-needs";
import { checkProofWithJev, toStoredMatch } from "../utils/witness-need-proof-jev";
import DocumentChunkRepo from "../repositories/document-chunk.repository";

export default class WitnessSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return WitnessRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, data: WitnessInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await WitnessRepo.create(caseId, data);
    await CaseGraphSvc.ensureNode(caseId, "WITNESS", row.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "witness.create", payload: { id: row.id } });
    return row;
  }

  static async update(
    caseId: string,
    id: string,
    userId: string,
    data: Partial<Omit<WitnessInput, "needsDone">> & { needsDone?: NeedDoneInput[] },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const { needsDone, ...rest } = data;
    let stored: unknown[] | undefined;
    if (needsDone) {
      // A tick needs proof: a document or photo that is in this case's Documents. Who and when are
      // stamped here, so a client can't claim someone else attached it.
      const current = (await WitnessRepo.list(caseId)).find((w) => w.id === id);
      if (!current) throw new HttpError("Witness not found", 404);
      const docs = await DocumentRepo.listAllByCase(caseId);
      const docById = new Map(docs.map((d) => [d.id, d]));
      const storedByKey = new Map(parseNeedsDone(current.needsDone).map((d) => [d.key, d]));
      const requirements = new Map(
        ((current.aiFactors as { needs?: { key: string; text: string }[] } | null)?.needs ?? []).map((n) => [n.key, n.text]),
      );

      // The proof has to show what the item asks for. Only new or changed ticks are checked; a
      // confident mismatch refuses the whole change, anything Jev can't judge is stored unconfirmed.
      const changed = needsDone.filter((n) => {
        const prior = storedByKey.get(n.key);
        return !prior || prior.documentId !== n.documentId;
      });
      const matches = new Map<string, NonNullable<NeedDone["match"]>>();
      const texts = await DocumentChunkRepo.findFullTextsByDocuments(
        changed.map((n) => n.documentId).filter((d) => docById.has(d)),
      );
      const mismatched: string[] = [];
      await Promise.all(
        changed.map(async (n) => {
          const doc = docById.get(n.documentId);
          const requirement = requirements.get(n.key);
          if (!doc || !requirement) return;
          const result = toStoredMatch(
            await checkProofWithJev({
              requirement,
              document: { name: doc.name, category: doc.category ?? null, summary: null, text: texts.get(doc.id) ?? null },
            }),
          );
          if (result === "REFUSE") mismatched.push(requirement);
          else matches.set(n.key, result);
        }),
      );
      if (mismatched.length) {
        throw new HttpError(`That document doesn't appear to show what's needed: ${mismatched[0]}`, 400);
      }

      const { done, rejected } = mergeNeedsDone(current.needsDone, needsDone, new Set(docs.map((d) => d.id)), userId, new Date(), matches);
      if (rejected.length) {
        throw new HttpError("Proof must be a document or photo from this case's Documents.", 400);
      }
      stored = done;
    }
    const row = await WitnessRepo.update(id, caseId, { ...rest, ...(stored ? { needsDone: stored } : {}) });
    if (!row) throw new HttpError("Witness not found", 404);
    await CaseGraphSvc.markStale(caseId, "WITNESS", id, "Witness updated");
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "witness.update", payload: { id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await WitnessRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Witness not found", 404);
    // CaseGraphViewSvc's "witnesses" view reads CaseGraphNode, never Witness directly — without
    // this the row keeps rendering as a ghost "Unnamed witness".
    await CaseGraphSvc.removeNode("WITNESS", id);
  }
}
