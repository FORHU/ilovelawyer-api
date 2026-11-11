import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import axios from "axios";
import * as chatWonder from "../src/utils/chatWonder";

describe("describeImage", () => {
  const originalPost = axios.post;
  afterEach(() => { (axios as any).post = originalPost; });

  it("returns the trimmed description on success", async () => {
    (axios as any).post = async () => ({ data: { success: true, description: "  A silver sedan.  ", usage: {} } });
    const result = await chatWonder.describeImage("k/car.jpg", "car_accident.jpg");
    expect(result).to.equal("A silver sedan.");
  });

  it("returns null when chat-wonder reports no description", async () => {
    (axios as any).post = async () => ({ data: { success: false, description: null, usage: {} } });
    const result = await chatWonder.describeImage("k/car.jpg", "car_accident.jpg");
    expect(result).to.equal(null);
  });

  it("returns null (never throws) when the request fails", async () => {
    (axios as any).post = async () => { throw new Error("network down"); };
    const result = await chatWonder.describeImage("k/car.jpg", "car_accident.jpg");
    expect(result).to.equal(null);
  });
});
