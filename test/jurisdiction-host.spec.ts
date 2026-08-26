import { expect } from "chai";
import { describe, it } from "mocha";
import { resolveJurisdictionFromHost, resolveJurisdictionFromRequest } from "../src/utils/jurisdiction-host";
import type { Request } from "express";

function requestWithOrigin(origin?: string): Request {
  return { headers: { origin } } as unknown as Request;
}

describe("resolveJurisdictionFromHost", () => {
  it("resolves the four production/local PH and UK hosts", () => {
    expect(resolveJurisdictionFromHost("ph.ilovelawyer.com")).to.equal("PH");
    expect(resolveJurisdictionFromHost("ph.ilovelawyer.local")).to.equal("PH");
    expect(resolveJurisdictionFromHost("uk.ilovelawyer.com")).to.equal("UK");
    expect(resolveJurisdictionFromHost("uk.ilovelawyer.local")).to.equal("UK");
  });

  it("strips a trailing port before matching", () => {
    expect(resolveJurisdictionFromHost("ph.ilovelawyer.local:3002")).to.equal("PH");
    expect(resolveJurisdictionFromHost("uk.ilovelawyer.local:3002")).to.equal("UK");
  });

  it("also resolves the bare ph.ilovelawyer/uk.ilovelawyer dev convention (no .local)", () => {
    expect(resolveJurisdictionFromHost("ph.ilovelawyer:3002")).to.equal("PH");
    expect(resolveJurisdictionFromHost("uk.ilovelawyer:3002")).to.equal("UK");
    expect(resolveJurisdictionFromHost("ph.ilovelawyer")).to.equal("PH");
    expect(resolveJurisdictionFromHost("uk.ilovelawyer")).to.equal("UK");
  });

  it("returns null for an unrecognized host, never guessing", () => {
    expect(resolveJurisdictionFromHost("ilovelawyer.com")).to.equal(null);
    expect(resolveJurisdictionFromHost("localhost:3002")).to.equal(null);
    expect(resolveJurisdictionFromHost("sg.ilovelawyer.com")).to.equal(null);
    expect(resolveJurisdictionFromHost(undefined)).to.equal(null);
    expect(resolveJurisdictionFromHost(null)).to.equal(null);
    expect(resolveJurisdictionFromHost("")).to.equal(null);
  });

  it("does not use substring matching", () => {
    // "ph." must be the actual subdomain, not merely present somewhere in the hostname.
    expect(resolveJurisdictionFromHost("notph.ilovelawyer.com")).to.equal(null);
    expect(resolveJurisdictionFromHost("evil.com/uk.ilovelawyer.com")).to.equal(null);
  });
});

describe("resolveJurisdictionFromRequest", () => {
  it("resolves jurisdiction from the Origin header, ignoring req.headers.host", () => {
    expect(resolveJurisdictionFromRequest(requestWithOrigin("https://ph.ilovelawyer.com"))).to.equal("PH");
    expect(resolveJurisdictionFromRequest(requestWithOrigin("http://uk.ilovelawyer.local:3002"))).to.equal("UK");
  });

  it("returns null when Origin is missing or unresolvable", () => {
    expect(resolveJurisdictionFromRequest(requestWithOrigin(undefined))).to.equal(null);
    expect(resolveJurisdictionFromRequest(requestWithOrigin("not-a-url"))).to.equal(null);
    expect(resolveJurisdictionFromRequest(requestWithOrigin("https://ilovelawyer.com"))).to.equal(null);
  });
});
