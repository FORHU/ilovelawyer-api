import { expect } from "chai";
import { describe, it } from "mocha";
import { suggestStrategyReadiness } from "../src/utils/strategy-readiness-jev";

describe("strategy readiness Jev", () => {
  it("returns null without calling Jev when the flag is off", async () => {
    delete process.env.USE_JEV_STRATEGY_READINESS;
    expect(await suggestStrategyReadiness({ label: "Rebut abandonment with the payroll series" })).to.equal(null);
  });
});
