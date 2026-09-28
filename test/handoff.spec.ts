import { expect } from "chai";
import { describe, it } from "mocha";
import { newHandoffCode, handoffKey } from "../src/utils/handoff";
import { consumeHandoffSchema } from "../src/validation/auth.validation";

describe("login handoff codes", () => {
  it("are 43 URL-safe characters, and different every time", () => {
    const a = newHandoffCode();
    const b = newHandoffCode();
    expect(a).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(a).to.not.equal(b);
  });

  it("are stored under their hash, never as themselves", () => {
    const code = newHandoffCode();
    const key = handoffKey(code);
    expect(key).to.match(/^auth:handoff:[0-9a-f]{64}$/);
    expect(key).to.not.include(code);
    expect(handoffKey(code)).to.equal(key);
  });

  it("are the only thing the consume endpoint accepts", () => {
    expect(consumeHandoffSchema.validate({ code: newHandoffCode() }).error).to.equal(undefined);
    expect(consumeHandoffSchema.validate({ code: "short" }).error).to.not.equal(undefined);
    expect(consumeHandoffSchema.validate({ code: "a".repeat(42) + "$" }).error).to.not.equal(undefined);
    expect(consumeHandoffSchema.validate({}).error).to.not.equal(undefined);
  });
});
