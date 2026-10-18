import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import fs from "fs";
import path from "path";
import {
  DirectLegislationError,
  frameableLegislationHtml,
  getLegislationSectionDirect,
  parseFeed,
  parseSection,
  searchLegislationDirect,
  searchUrl,
} from "../src/utils/uk-legislation-direct";
import {
  legislationGetSection,
  legislationSearch,
  legislationTitleLookup,
  UkLegalMcpUnavailableError,
} from "../src/utils/uk-legal-mcp";
import HttpError from "../src/utils/http-error";

// Trimmed copies of real legislation.gov.uk responses. The network is faked.
const FEED = fs.readFileSync(path.join(__dirname, "fixtures/uk-legislation/feed_title.xml"), "utf8");
const SECTION_29 = fs.readFileSync(path.join(__dirname, "fixtures/uk-legislation/section_29.xml"), "utf8");

const WAF_TEXT =
  'Internal error: {"error_category": "transient", "is_retryable": true, "description": "legislation.gov.uk returned an AWS WAF JavaScript challenge for https://www.legislation.gov.uk/ukpga/1953/20/section/29."}';

function emptyFeed(): string {
  return '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
}

describe("parseFeed", () => {
  it("gives an old Act its calendar year and number, not its regnal-year id", () => {
    // The feed id for the 1953 Act is .../id/ukpga/Eliz2/1-2/20; the Library needs .../ukpga/1953/20.
    const act = parseFeed(FEED).find((h) => h.title === "Births and Deaths Registration Act 1953");
    expect(act).to.deep.include({ type: "ukpga", year: 1953, number: 20, url: "https://www.legislation.gov.uk/ukpga/1953/20" });
  });

  it("reads a modern Act", () => {
    const act = parseFeed(FEED).find((h) => h.title.includes("Scotland"));
    expect(act).to.deep.include({ type: "ukpga", year: 1965, number: 49 });
  });

  it("honours the limit and the year filter", () => {
    expect(parseFeed(FEED, 1)).to.have.length(1);
    expect(parseFeed(FEED, 20, 1953).map((h) => h.year)).to.deep.equal([1953]);
  });

  it("an empty feed is an empty list, not an error", () => {
    expect(parseFeed(emptyFeed())).to.deep.equal([]);
  });
});

describe("searchUrl", () => {
  it("a title search with no type uses the all feed", () => {
    const url = searchUrl({ query: "Human Rights Act" }, false);
    expect(url).to.match(/^https:\/\/www\.legislation\.gov\.uk\/all\/data\.feed\?/);
    expect(url).to.contain("title=Human+Rights+Act");
  });

  it("type and year go in the path", () => {
    expect(searchUrl({ query: "Births", type: "ukpga", year: 1953 }, false)).to.match(/\/ukpga\/1953\/data\.feed\?/);
  });

  it("full text uses the search feed", () => {
    const url = searchUrl({ query: "correction of errors", type: "ukpga" }, true);
    expect(url).to.contain("/search/data.feed?");
    expect(url).to.contain("text=correction+of+errors");
    expect(url).to.contain("type=ukpga");
  });
});

describe("searchLegislationDirect", () => {
  const act = ["Births and Deaths Registration Act 1953"];
  const feedWith = (titles: string[]) =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:ukm="http://www.legislation.gov.uk/namespaces/metadata">${titles
      .map((t) => `<entry><id>http://www.legislation.gov.uk/id/ukpga/1953/20</id><title>${t}</title><ukm:Year Value="1953"/><ukm:Number Value="20"/></entry>`)
      .join("")}</feed>`;

  it("a title that matches is one request", async () => {
    const urls: string[] = [];
    const res = await searchLegislationDirect({ query: "Births and Deaths Registration Act 1953" }, async (url) => {
      urls.push(url);
      return new Response(feedWith(act));
    });
    expect(res.results[0].title).to.equal(act[0]);
    expect(urls).to.have.length(1);
  });

  it("falls through to full text when the title search finds nothing", async () => {
    const urls: string[] = [];
    const res = await searchLegislationDirect({ query: "correction of errors in registers" }, async (url) => {
      urls.push(url);
      return new Response(url.includes("/search/data.feed") ? feedWith(act) : emptyFeed());
    });
    expect(res.results).to.have.length(1);
    expect(urls).to.have.length(2);
    expect(urls[1]).to.contain("text=");
  });

  it("nothing anywhere is an empty result", async () => {
    const res = await searchLegislationDirect({ query: "zzzz" }, async () => new Response(emptyFeed()));
    expect(res).to.deep.equal({ results: [], total: 0 });
  });

  it("a firewall challenge page is an error, never parsed as results", async () => {
    const page = "<html><script src='https://x.awswaf.com/challenge.js'></script></html>";
    let caught: unknown;
    await searchLegislationDirect({ query: "x" }, async () => new Response(page)).catch((e) => (caught = e));
    expect(caught).to.be.instanceOf(DirectLegislationError);
    expect(String((caught as Error).message)).to.match(/challenge/i);
  });

  it("a 404 is reported as not found", async () => {
    let caught: unknown;
    await getLegislationSectionDirect({ type: "ukpga", year: 1953, number: 20, section: "999" }, async () => new Response("", { status: 404 })).catch(
      (e) => (caught = e),
    );
    expect(String((caught as Error).message)).to.match(/not found/i);
  });
});

describe("frameableLegislationHtml", () => {
  // Same shape as legislation.gov.uk's data.html: root-relative assets, absolute cross-references, in-page footnotes.
  const HTML =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></meta><link rel="stylesheet" href="/styles/HTML5_styles/primary.css"></link></head>' +
    '<body><header>x</header><img src="/images/crests/ukpga.gif"><a href="http://www.legislation.gov.uk/ukpga/1998/42/section/2">s 2</a>' +
    '<a class="LegCommentaryLink" href="#commentary-c1">F1</a></body></html>';

  it("points root-relative assets back at legislation.gov.uk", () => {
    const out = frameableLegislationHtml(HTML);
    expect(out).to.contain('href="https://www.legislation.gov.uk/styles/HTML5_styles/primary.css"');
    expect(out).to.contain('src="https://www.legislation.gov.uk/images/crests/ukpga.gif"');
  });

  it("opens links in a new tab but keeps in-page footnote links in the frame", () => {
    const out = frameableLegislationHtml(HTML);
    expect(out).to.contain('<head><base target="_blank">');
    expect(out).to.contain('<header>x</header>');
    expect(out).to.contain('<a target="_self" class="LegCommentaryLink" href="#commentary-c1">');
    expect(out).to.contain('<a href="http://www.legislation.gov.uk/ukpga/1998/42/section/2">');
  });

  it("still sets the new-tab default on a fragment with no <head>", () => {
    expect(frameableLegislationHtml("<p>text</p>")).to.equal('<base target="_blank"><p>text</p>');
  });
});

describe("parseSection", () => {
  const res = parseSection(SECTION_29);

  it("reads the heading and section number", () => {
    expect(res.title).to.equal("Correction of errors in registers.");
    expect(res.section_number).to.equal("29");
  });

  it("returns plain text with the subsections", () => {
    expect(res.content).to.contain("No alteration shall be made in any register of live–births");
    expect(res.content).to.contain("Any clerical error which may from time to time be discovered");
    expect(res.content).to.not.contain("<");
  });

  it("keeps inserted text in reading order", () => {
    expect(res.content).to.contain("either by two credible persons having knowledge of the truth of the case");
  });

  it("reads the territorial extent", () => {
    expect(res.extent).to.deep.equal(["England", "Wales"]);
  });

  it("does not assert in-force status it was not told", () => {
    expect(res.in_force).to.equal(null);
  });

  it("truncates to maxChars and says so", () => {
    const short = parseSection(SECTION_29, 120);
    expect(short.content.length).to.be.at.most(120);
    expect(short.content_truncated).to.equal(true);
    expect(res.content_truncated).to.equal(false);
  });

  it("a document with no section body is an error", () => {
    const bare = '<Legislation xmlns="http://www.legislation.gov.uk/namespaces/legislation"><Primary><Body/></Primary></Legislation>';
    expect(() => parseSection(bare)).to.throw(DirectLegislationError);
  });
});

// ── wiring in uk-legal-mcp.ts: the MCP first, legislation.gov.uk when it fails ──────────────────────────────

describe("legislation tools fall back to legislation.gov.uk", () => {
  const realFetch = globalThis.fetch;
  let mcpCalls: number;
  let govCalls: number;
  let mcpReply: () => Response;

  const mcpToolError = (text: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text }] } }));

  beforeEach(() => {
    mcpCalls = 0;
    govCalls = 0;
    mcpReply = () => mcpToolError(WAF_TEXT);
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("legislation.gov.uk")) {
        govCalls++;
        return new Response(url.includes("/data.xml") ? SECTION_29 : FEED);
      }
      mcpCalls++;
      return mcpReply();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.UK_LEGISLATION_DIRECT_FALLBACK;
  });

  it("legislation_search: a blocked MCP is answered from legislation.gov.uk", async () => {
    const res = await legislationSearch({ query: "Births and Deaths Registration Act 1953", limit: 5 });
    expect(res.results.some((h) => h.title === "Births and Deaths Registration Act 1953")).to.equal(true);
    expect(mcpCalls).to.equal(1);
    expect(govCalls).to.be.greaterThan(0);
  });

  it("legislation_search: a working MCP is used and legislation.gov.uk is not touched", async () => {
    mcpReply = () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [], total: 0 } } }));
    const res = await legislationSearch({ query: "x" });
    expect(res).to.deep.equal({ results: [], total: 0 });
    expect(govCalls).to.equal(0);
  });

  it("legislation_search: a caller's bad input (400) is not swallowed by the fallback", async () => {
    mcpReply = () => mcpToolError('Internal error: {"error_category": "validation", "description": "bad court"}');
    let caught: unknown;
    await legislationSearch({ query: "x" }).catch((e) => (caught = e));
    expect(caught).to.be.instanceOf(HttpError);
    expect(govCalls).to.equal(0);
  });

  it("the fallback can be switched off", async () => {
    process.env.UK_LEGISLATION_DIRECT_FALLBACK = "false";
    let caught: unknown;
    await legislationSearch({ query: "x" }).catch((e) => (caught = e));
    expect(caught).to.be.instanceOf(UkLegalMcpUnavailableError);
    expect(govCalls).to.equal(0);
  });

  it("both failing is still an UkLegalMcpUnavailableError that names both reasons", async () => {
    globalThis.fetch = (async (input: unknown) =>
      String(input).includes("legislation.gov.uk") ? new Response("", { status: 404 }) : mcpToolError(WAF_TEXT)) as typeof fetch;
    let caught: unknown;
    await legislationGetSection({ type: "ukpga", year: 1953, number: 20, section: "99" }).catch((e) => (caught = e));
    expect(caught).to.be.instanceOf(UkLegalMcpUnavailableError);
    expect(String((caught as Error).message)).to.match(/WAF/);
    expect(String((caught as Error).message)).to.match(/not found/i);
  });

  it("legislation_get_section: a blocked MCP is answered from legislation.gov.uk", async () => {
    const res = await legislationGetSection({ type: "ukpga", year: 1953, number: 20, section: "29" });
    expect(res.section_number).to.equal("29");
    expect(res.content).to.contain("No alteration shall be made");
  });

  it("legislationTitleLookup asks legislation.gov.uk first, so a blocked MCP cannot eat the caller's time budget", async () => {
    const res = await legislationTitleLookup({ query: "Births and Deaths Registration Act 1953", limit: 5 });
    expect(res.results.length).to.be.greaterThan(0);
    expect(mcpCalls).to.equal(0);
  });

  it("legislationTitleLookup uses the MCP when legislation.gov.uk has nothing", async () => {
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes("legislation.gov.uk")) return new Response(emptyFeed());
      mcpCalls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [], total: 0 } } }));
    }) as typeof fetch;
    await legislationTitleLookup({ query: "zzzz" });
    expect(mcpCalls).to.equal(1);
  });
});
