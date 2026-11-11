import { expect } from "chai";
import { describe, it } from "mocha";
import { isImageDocument } from "../src/utils/document-text-extraction";

describe("isImageDocument", () => {
  it("is true for image/jpeg and image/png mime types", () => {
    expect(isImageDocument("image/jpeg", "whatever")).to.equal(true);
    expect(isImageDocument("image/png", "whatever")).to.equal(true);
  });

  it("is true for .jpg/.jpeg/.png filenames when mimeType is missing", () => {
    expect(isImageDocument(null, "car_accident.jpg")).to.equal(true);
    expect(isImageDocument(undefined, "scan.PNG")).to.equal(true);
  });

  it("is false for non-image documents", () => {
    expect(isImageDocument("application/pdf", "contract.pdf")).to.equal(false);
    expect(isImageDocument(null, "notes.txt")).to.equal(false);
  });
});
