/** AnnotationSvc — comments/disputes/alternative-readings on any case element
 * (differentiation program, Phase 2). No live Postgres: AnnotationRepo and CaseAccess are
 * monkeypatched, same idiom as test/decision-record-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AnnotationSvc from "../src/services/annotation.service";
import AnnotationRepo from "../src/repositories/annotation.repository";
import CaseAccess from "../src/utils/case-access";

describe("AnnotationSvc", () => {
  const originals = {
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    assertCanEdit: CaseAccess.assertCanEdit,
    list: AnnotationRepo.list,
    create: AnnotationRepo.create,
    setResolved: AnnotationRepo.setResolved,
  };
  let editChecked: boolean;
  let viewChecked: boolean;

  beforeEach(() => {
    editChecked = false;
    viewChecked = false;
    (CaseAccess as any).loadAccessibleCase = async () => {
      viewChecked = true;
      return { id: "case-1" };
    };
    (CaseAccess as any).assertCanEdit = async () => {
      editChecked = true;
      return { id: "case-1" };
    };
  });

  afterEach(() => {
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (CaseAccess as any).assertCanEdit = originals.assertCanEdit;
    (AnnotationRepo as any).list = originals.list;
    (AnnotationRepo as any).create = originals.create;
    (AnnotationRepo as any).setResolved = originals.setResolved;
  });

  it("list only checks VIEW access, not EDIT", async () => {
    (AnnotationRepo as any).list = async () => [{ id: "a1" }];
    const rows = await AnnotationSvc.list("case-1", "viewer-1", "DECISION" as any, "dr-1");
    expect(rows).to.deep.equal([{ id: "a1" }]);
    expect(viewChecked).to.be.true;
    expect(editChecked).to.be.false;
  });

  it("create requires EDIT access and stamps the author", async () => {
    let seenData: any;
    (AnnotationRepo as any).create = async (caseId: string, data: any) => {
      seenData = { caseId, ...data };
      return { id: "a1", ...seenData };
    };
    await AnnotationSvc.create("case-1", "user-1", { targetType: "DECISION" as any, targetId: "dr-1", kind: "NOTE" as any, body: "Worth a second look." });
    expect(editChecked).to.be.true;
    expect(seenData).to.include({ caseId: "case-1", authorUserId: "user-1", targetId: "dr-1", body: "Worth a second look." });
  });

  it("resolve sets resolvedAt and reopen clears it", async () => {
    let lastResolvedAt: Date | null | undefined;
    (AnnotationRepo as any).setResolved = async (id: string, caseId: string, resolvedAt: Date | null) => {
      lastResolvedAt = resolvedAt;
      return { id, caseId, resolvedAt };
    };
    const resolved = await AnnotationSvc.resolve("case-1", "a1", "user-1");
    expect(resolved.resolvedAt).to.not.be.null;
    expect(lastResolvedAt).to.not.be.null;

    await AnnotationSvc.reopen("case-1", "a1", "user-1");
    expect(lastResolvedAt).to.be.null;
  });

  it("resolve throws 404 when the annotation isn't in this case", async () => {
    (AnnotationRepo as any).setResolved = async () => null;
    let threw: any;
    try {
      await AnnotationSvc.resolve("case-1", "missing", "user-1");
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.statusCode ?? threw.status).to.equal(404);
  });
});
