import { expect } from "chai";
import { describe, it } from "mocha";
import { formatPinpointFromEid } from "../src/utils/citation-pinpoint";

describe("formatPinpointFromEid", () => {
  it("extracts the paragraph number from a para_N eId", () => {
    expect(formatPinpointFromEid("para_4")).to.equal("para. 4");
    expect(formatPinpointFromEid("para_123")).to.equal("para. 123");
  });

  it("falls back to the raw eId when it has no digits", () => {
    expect(formatPinpointFromEid("header")).to.equal("header");
  });
});
