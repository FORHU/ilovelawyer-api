/** originForTenantCode — which CLIENT_URL origin a tenant's emailed links (e.g. the lawyer
 * approval email) open on. Pure: the origin list is passed in. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { originForTenantCode } from "../src/utils/tenant-host";

const LOCAL = [
  "http://localhost:3002",
  "http://ph.ilovelawyer.local:3002",
  "https://uk-local.ilovelawyer.com:3002",
  "http://uk.ilovelawyer.local:3002",
];

describe("originForTenantCode", () => {
  it("picks the first origin whose host belongs to the tenant, uk-local included", () => {
    expect(originForTenantCode("UK", LOCAL)).to.equal("https://uk-local.ilovelawyer.com:3002");
    expect(originForTenantCode("PH", LOCAL)).to.equal("http://ph.ilovelawyer.local:3002");
  });

  it("gives production its own site, skipping hosts that name no tenant", () => {
    const prod = ["https://app.ilovelawyer.com", "https://ph.ilovelawyer.com", "https://uk.ilovelawyer.com", "https://uk-dev.ilovelawyer.com"];
    expect(originForTenantCode("UK", prod)).to.equal("https://uk.ilovelawyer.com");
    expect(originForTenantCode("PH", prod)).to.equal("https://ph.ilovelawyer.com");
  });

  it("matches the -dev hosts too", () => {
    const staging = ["https://ph-dev.ilovelawyer.com", "https://admin-dev.ilovelawyer.com", "https://uk-dev.ilovelawyer.com"];
    expect(originForTenantCode("UK", staging)).to.equal("https://uk-dev.ilovelawyer.com");
  });

  it("falls back to the first origin when the tenant is unknown or has no host", () => {
    expect(originForTenantCode(null, LOCAL)).to.equal("http://localhost:3002");
    expect(originForTenantCode("UK", ["http://localhost:3002", "http://ph.ilovelawyer.local:3002"])).to.equal("http://localhost:3002");
  });
});
