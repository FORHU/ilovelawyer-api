/** #410: the request builders the option-order benchmark uses must send exactly what production
 * sends, and a reversed order may change nothing but the order of the options. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { validityRequest } from "../src/utils/citation-validity";
import { propositionRequest } from "../src/utils/citation-proposition";
import { assertionRequest } from "../src/utils/assertion-check";

const optionsOf = (question: unknown) => Object.keys((question as { criteria: Record<string, null> }).criteria);
const withoutCriteria = (question: unknown) => {
  const { criteria: _criteria, ...rest } = question as { criteria: unknown };
  return rest;
};

describe("Jev request builders and option order", () => {
  it("citation validity keeps today's order by default", () => {
    expect(optionsOf(validityRequest("q", "o").questions.validity)).to.deep.equal(["VALID", "INVALID", "ADVERSE"]);
  });

  it("citation type keeps today's order by default", () => {
    expect(optionsOf(propositionRequest("q", "o").questions.propositionType)).to.deep.equal(["PARAPHRASED", "INFERRED"]);
  });

  it("assertion check keeps today's order by default", () => {
    expect(optionsOf(assertionRequest("a", "p", "D1").questions.support)).to.deep.equal(["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"]);
  });

  it("a reversed order changes only the order of the options", () => {
    const normal = validityRequest("quote", "official");
    const reversed = validityRequest("quote", "official", ["ADVERSE", "INVALID", "VALID"]);
    expect(reversed.state).to.deep.equal(normal.state);
    expect(withoutCriteria(reversed.questions.validity)).to.deep.equal(withoutCriteria(normal.questions.validity));
    expect(optionsOf(reversed.questions.validity)).to.deep.equal(["ADVERSE", "INVALID", "VALID"]);

    const normalAssertion = assertionRequest("a", "p", "D1");
    const reversedAssertion = assertionRequest("a", "p", "D1", ["CONTRADICTED", "UNSUPPORTED", "SUPPORTED"]);
    expect(reversedAssertion.questions.evidenceKind).to.deep.equal(normalAssertion.questions.evidenceKind);
    expect(optionsOf(reversedAssertion.questions.support)).to.deep.equal(["CONTRADICTED", "UNSUPPORTED", "SUPPORTED"]);
  });
});
