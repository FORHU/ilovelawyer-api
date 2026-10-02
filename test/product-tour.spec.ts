/** Onboarding tour progress (ProductTourSvc + the PUT body schema). The app runs the tour; the
 * API only remembers where each user is.
 *
 * No live Postgres: ProductTourRepo is monkeypatched on its CommonJS module object, same idiom
 * as test/signup-auto-approve.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ProductTourSvc from "../src/services/product-tour.service";
import ProductTourRepo from "../src/repositories/product-tour.repository";
import { saveProductTourSchema } from "../src/validation/users.validation";

describe("ProductTourSvc", () => {
  const originals = { find: ProductTourRepo.find, upsert: ProductTourRepo.upsert };
  let rows: Map<string, any>;

  beforeEach(() => {
    rows = new Map();
    (ProductTourRepo as any).find = async (userId: string, track: string) => rows.get(`${userId}:${track}`) ?? null;
    (ProductTourRepo as any).upsert = async (userId: string, track: string, data: any) => {
      const row = { userId, track, ...data, updatedAt: new Date() };
      rows.set(`${userId}:${track}`, row);
      return row;
    };
  });

  afterEach(() => {
    (ProductTourRepo as any).find = originals.find;
    (ProductTourRepo as any).upsert = originals.upsert;
  });

  it("reads as NOT_STARTED for a user who never opened the tour", async () => {
    const state = await ProductTourSvc.get("u1", "main");
    expect(state).to.deep.include({ status: "NOT_STARTED", archetype: null, currentStep: null, doneSteps: [] });
  });

  it("saves progress and reads it back", async () => {
    await ProductTourSvc.save("u1", "main", { status: "IN_PROGRESS", archetype: "solo", currentStep: "attach", doneSteps: ["ask"] });
    const state = await ProductTourSvc.get("u1", "main");
    expect(state).to.deep.include({ status: "IN_PROGRESS", archetype: "solo", currentStep: "attach", doneSteps: ["ask"] });
  });

  it("drops the current step once the tour stops running, and de-duplicates done steps", async () => {
    const state = await ProductTourSvc.save("u1", "main", {
      status: "COMPLETED",
      archetype: "solo",
      currentStep: "guide",
      doneSteps: ["ask", "ask", "guide"],
    });
    expect(state.currentStep).to.equal(null);
    expect(state.doneSteps).to.deep.equal(["ask", "guide"]);
  });

  it("keeps each user's progress separate", async () => {
    await ProductTourSvc.save("u1", "main", { status: "DISMISSED", archetype: null, currentStep: null, doneSteps: [] });
    expect((await ProductTourSvc.get("u2", "main")).status).to.equal("NOT_STARTED");
  });
});

describe("saveProductTourSchema", () => {
  it("accepts a running tour and fills in defaults", () => {
    const { error, value } = saveProductTourSchema.validate({ status: "IN_PROGRESS", currentStep: "ask" });
    expect(error).to.equal(undefined);
    expect(value).to.deep.equal({ status: "IN_PROGRESS", currentStep: "ask", archetype: null, doneSteps: [] });
  });

  it("accepts the Terminal tour's camelCase step ids", () => {
    const { error } = saveProductTourSchema.validate({
      status: "IN_PROGRESS",
      currentStep: "legalIssues",
      doneSteps: ["nextdate", "redTeam", "addPane"],
    });
    expect(error).to.equal(undefined);
  });

  it("rejects an unknown status, practice type or malformed step id", () => {
    expect(saveProductTourSchema.validate({ status: "PAUSED" }).error).to.not.equal(undefined);
    expect(saveProductTourSchema.validate({ status: "IN_PROGRESS", archetype: "partner" }).error).to.not.equal(undefined);
    expect(saveProductTourSchema.validate({ status: "IN_PROGRESS", currentStep: "<script>" }).error).to.not.equal(undefined);
  });
});
