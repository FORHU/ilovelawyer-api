import { expect } from "chai";
import { describe, it } from "mocha";
import errorHandler from "../src/middleware/error-handler.middleware";
import HttpError from "../src/utils/http-error";

function run(err: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  errorHandler(err, {} as never, res as never, () => {});
  return sent;
}

describe("errorHandler with HttpError details", () => {
  it("sends the message alone when there are no details", () => {
    expect(run(new HttpError("nope", 422))).to.deep.equal({ status: 422, body: { message: "nope" } });
  });

  it("sends a code next to the message when there is one", () => {
    expect(run(new HttpError("nope", 409, "SOME_CODE"))).to.deep.equal({ status: 409, body: { message: "nope", code: "SOME_CODE" } });
  });

  it("spreads the details next to the message and code", () => {
    const blockers = [{ code: "NO_DOCUMENTS" }];
    expect(run(new HttpError("nope", 422, "EVENT_PREREQUISITES", { blockers }))).to.deep.equal({
      status: 422,
      body: { message: "nope", code: "EVENT_PREREQUISITES", blockers },
    });
  });

  it("sends details without a code when only details are given", () => {
    expect(run(new HttpError("nope", 422, undefined, { blockers: [] }))).to.deep.equal({ status: 422, body: { message: "nope", blockers: [] } });
  });
});
