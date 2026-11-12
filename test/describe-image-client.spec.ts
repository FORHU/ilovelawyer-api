import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import axios from "axios";
import * as s3 from "../src/utils/s3";
import * as chatWonder from "../src/utils/chatWonder";

describe("describeImage", () => {
  const originalPost = axios.post;
  const originalGetPresignedGetUrl = s3.getPresignedGetUrl;

  beforeEach(() => {
    (s3 as any).getPresignedGetUrl = async (key: string) => `https://signed.example/${key}`;
  });

  afterEach(() => {
    (axios as any).post = originalPost;
    (s3 as any).getPresignedGetUrl = originalGetPresignedGetUrl;
  });

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

  it("sends a presigned image_url instead of the raw s3_key", async () => {
    let capturedBody: any;
    (axios as any).post = async (_url: string, body: any) => {
      capturedBody = body;
      return { data: { success: true, description: "A silver sedan.", usage: {} } };
    };
    const result = await chatWonder.describeImage("k/car.jpg", "car_accident.jpg");
    expect(result).to.equal("A silver sedan.");
    expect(capturedBody).to.have.property("image_url", "https://signed.example/k/car.jpg");
    expect(capturedBody).to.not.have.property("s3_key");
  });
});
