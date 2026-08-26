import { expect } from "chai";
import { describe, it } from "mocha";
import { getLegalKnowledgeProvider } from "../src/legal/legal-knowledge.registry";

async function expectComingSoon(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.fail("expected the UK corpus method to reject as coming-soon");
  } catch (err) {
    expect(err).to.be.instanceOf(Error);
    expect((err as Error).message).to.match(/coming soon/i);
  }
}

describe("Legal knowledge provider jurisdiction selection", () => {
  it("selects the PH provider with an available corpus", () => {
    const provider = getLegalKnowledgeProvider("PH");
    expect(provider.jurisdiction).to.equal("PH");
    expect(provider.corpusAvailable).to.equal(true);
  });

  it("selects the UK provider with an unavailable corpus", () => {
    const provider = getLegalKnowledgeProvider("UK");
    expect(provider.jurisdiction).to.equal("UK");
    expect(provider.corpusAvailable).to.equal(false);
  });

  it("rejects every UK corpus-backed method with a coming-soon error, never PH data", async () => {
    const provider = getLegalKnowledgeProvider("UK");

    await expectComingSoon(provider.getCategories());
    await expectComingSoon(provider.getSubcategories("torts"));
    await expectComingSoon(provider.list({ page: 1, limit: 20 }));
    await expectComingSoon(provider.getLibrarySections());
    await expectComingSoon(provider.search("contract", 5));
    await expectComingSoon(provider.vectorSearch([0.1], 5, 0, 0.3));
    await expectComingSoon(provider.getById(1));
    await expectComingSoon(provider.getRelated(1, 5));
    await expectComingSoon(provider.getSourcePageDoc("1"));
  });

  it("throws rather than silently falling back for an unmapped jurisdiction", () => {
    // @ts-expect-error deliberately unsupported
    expect(() => getLegalKnowledgeProvider("SG")).to.throw(/No legal-knowledge provider configured/);
  });
});
