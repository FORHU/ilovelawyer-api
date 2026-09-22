import { expect } from "chai";
import { describe, it } from "mocha";
import { resolveTenantCodeFromHost, resolveTenantCodeFromRequest } from "../src/utils/tenant-host";
import type { Request } from "express";

function requestWithOrigin(origin?: string): Request {
  return { headers: { origin } } as unknown as Request;
}

describe("resolveTenantCodeFromHost", () => {
  it("resolves the four production/local PH and UK hosts", () => {
    expect(resolveTenantCodeFromHost("ph.ilovelawyer.com")).to.equal("PH");
    expect(resolveTenantCodeFromHost("ph.ilovelawyer.local")).to.equal("PH");
    expect(resolveTenantCodeFromHost("uk.ilovelawyer.com")).to.equal("UK");
    expect(resolveTenantCodeFromHost("uk.ilovelawyer.local")).to.equal("UK");
  });

  it("strips a trailing port before matching", () => {
    expect(resolveTenantCodeFromHost("ph.ilovelawyer.local:3002")).to.equal("PH");
    expect(resolveTenantCodeFromHost("uk.ilovelawyer.local:3002")).to.equal("UK");
  });

  it("also resolves the bare ph.ilovelawyer/uk.ilovelawyer dev convention (no .local)", () => {
    expect(resolveTenantCodeFromHost("ph.ilovelawyer:3002")).to.equal("PH");
    expect(resolveTenantCodeFromHost("uk.ilovelawyer:3002")).to.equal("UK");
    expect(resolveTenantCodeFromHost("ph.ilovelawyer")).to.equal("PH");
    expect(resolveTenantCodeFromHost("uk.ilovelawyer")).to.equal("UK");
  });

  it("returns null for an unrecognized host, never guessing", () => {
    expect(resolveTenantCodeFromHost("ilovelawyer.com")).to.equal(null);
    expect(resolveTenantCodeFromHost("localhost:3002")).to.equal(null);
    expect(resolveTenantCodeFromHost("sg.ilovelawyer.com")).to.equal(null);
    expect(resolveTenantCodeFromHost(undefined)).to.equal(null);
    expect(resolveTenantCodeFromHost(null)).to.equal(null);
    expect(resolveTenantCodeFromHost("")).to.equal(null);
  });

  it("does not use substring matching", () => {
    // "ph." must be the actual subdomain, not merely present somewhere in the hostname.
    expect(resolveTenantCodeFromHost("notph.ilovelawyer.com")).to.equal(null);
    expect(resolveTenantCodeFromHost("evil.com/uk.ilovelawyer.com")).to.equal(null);
  });
});

describe("resolveTenantCodeFromRequest", () => {
  it("resolves the tenant code from the Origin header, ignoring req.headers.host", () => {
    expect(resolveTenantCodeFromRequest(requestWithOrigin("https://ph.ilovelawyer.com"))).to.equal("PH");
    expect(resolveTenantCodeFromRequest(requestWithOrigin("http://uk.ilovelawyer.local:3002"))).to.equal("UK");
  });

  it("returns null when Origin is missing or unresolvable", () => {
    expect(resolveTenantCodeFromRequest(requestWithOrigin(undefined))).to.equal(null);
    expect(resolveTenantCodeFromRequest(requestWithOrigin("not-a-url"))).to.equal(null);
    expect(resolveTenantCodeFromRequest(requestWithOrigin("https://ilovelawyer.com"))).to.equal(null);
  });
});
