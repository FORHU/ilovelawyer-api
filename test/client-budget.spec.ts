/** Client Budget: what a client says they can spend on a lawyer, set on Create case (a range, their
 * own amount, or "Not sure") and carried into the brief. Stored as a low and a high in pence. No DB. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { budgetColumns, budgetOf } from "../src/utils/client-budget";
import { createClientCaseSchema, updateClientCaseSchema } from "../src/validation/client-case.validation";

const newCase = { title: "Dismissed", areas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" };

describe("Client Budget", () => {
  describe("budgetOf", () => {
    it("is null when nothing is set, as on a case made before budgets", () => {
      expect(budgetOf({ budgetMinMinor: null, budgetMaxMinor: null, budgetFeePreference: null })).to.equal(null);
      expect(budgetOf({})).to.equal(null);
    });

    it("reads a range, an open-ended range and a fee preference on its own", () => {
      expect(budgetOf({ budgetMinMinor: 50_000, budgetMaxMinor: 150_000, budgetFeePreference: "FIXED_FEE" })).to.deep.equal({
        minMinor: 50_000,
        maxMinor: 150_000,
        feePreference: "FIXED_FEE",
      });
      expect(budgetOf({ budgetMinMinor: 500_000, budgetMaxMinor: null, budgetFeePreference: null })).to.deep.equal({ minMinor: 500_000, maxMinor: null, feePreference: null });
      expect(budgetOf({ budgetMinMinor: null, budgetMaxMinor: null, budgetFeePreference: "FIRST_CONSULTATION" })).to.deep.equal({
        minMinor: null,
        maxMinor: null,
        feePreference: "FIRST_CONSULTATION",
      });
    });
  });

  describe("budgetColumns", () => {
    it("clears all three for null, and writes each field otherwise", () => {
      expect(budgetColumns(null)).to.deep.equal({ budgetMinMinor: null, budgetMaxMinor: null, budgetFeePreference: null });
      expect(budgetColumns({ minMinor: 120_000, maxMinor: 120_000, feePreference: null })).to.deep.equal({
        budgetMinMinor: 120_000,
        budgetMaxMinor: 120_000,
        budgetFeePreference: null,
      });
    });
  });

  describe("validation", () => {
    const budget = (b: unknown) => createClientCaseSchema.validate({ ...newCase, budget: b });

    it("takes a range, the client's own amount (low = high), an open top, null, or no budget at all", () => {
      expect(budget({ minMinor: 50_000, maxMinor: 150_000, feePreference: "FIXED_FEE" }).error).to.equal(undefined);
      expect(budget({ minMinor: 120_000, maxMinor: 120_000, feePreference: null }).error).to.equal(undefined);
      expect(budget({ minMinor: 500_000, maxMinor: null, feePreference: null }).error).to.equal(undefined);
      expect(budget(null).error).to.equal(undefined);
      expect(createClientCaseSchema.validate(newCase).error).to.equal(undefined);
    });

    it("refuses a low above the high, negative or fractional pence, and an unknown fee type", () => {
      expect(budget({ minMinor: 150_000, maxMinor: 50_000, feePreference: null }).error?.message).to.match(/low.*high/i);
      expect(budget({ minMinor: -1, maxMinor: null, feePreference: null }).error).to.not.equal(undefined);
      expect(budget({ minMinor: 10.5, maxMinor: null, feePreference: null }).error).to.not.equal(undefined);
      expect(budget({ minMinor: null, maxMinor: null, feePreference: "HOURLY" }).error).to.not.equal(undefined);
    });

    it("lets an edit change only the budget", () => {
      expect(updateClientCaseSchema.validate({ budget: { minMinor: 0, maxMinor: 50_000, feePreference: null } }).error).to.equal(undefined);
      expect(updateClientCaseSchema.validate({ budget: null }).error).to.equal(undefined);
    });
  });
});
