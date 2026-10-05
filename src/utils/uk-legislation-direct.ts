import * as cheerio from "cheerio";
import type { UkLegislationSearchHit, UkLegislationSearchResult, UkLegislationSectionResult } from "./uk-legal-mcp";

// ── legislation.gov.uk, read directly ────────────────────────────────────────
// uk-legal-mcp.fly.dev fetches legislation.gov.uk from its own host, and legislation.gov.uk's AWS WAF has
// been answering that host with a JavaScript challenge ("legislation.gov.uk returned an AWS WAF JavaScript
// challenge …"), so legislation_search / legislation_get_section fail while the same public endpoints answer
// normally from our own hosts. These functions call those endpoints directly and return the shapes the MCP
// client returns, so callers do not change. See chat-wonder-v2-api's uk_legal_mcp/direct.py for the same fallback.
//
//   search by title   {BASE}/{type|all}[/{year}]/data.feed?title=…
//   search full text  {BASE}/search/data.feed?text=…[&type=…][&year=…]
//   one section       {BASE}/{type}/{year}/{number}/section/{section}/data.xml

const BASE = "https://www.legislation.gov.uk";
const USER_AGENT = "ilovelawyer-api/1.0 (UK legislation lookup)";
// The first XML fetch of a section took ~6s from a cold start.
const TIMEOUT_MS = 30_000;

/** legislation.gov.uk could not be reached, refused, or answered with something that is not legislation. */
export class DirectLegislationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectLegislationError";
  }
}

/** The few fields of a parsed XML node that the text flattening reads (cheerio/domhandler nodes satisfy it). */
interface XmlNode {
  type: string;
  data?: string;
  name?: string;
  children?: XmlNode[];
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const WAF_CHALLENGE = /awswaf|AwsWafIntegration|aws-waf/i;

async function fetchText(url: string, fetchImpl: FetchLike): Promise<string> {
  let lastError = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/xml, application/atom+xml" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : "request failed";
      if (attempt === 0) continue;
      throw new DirectLegislationError(`could not reach legislation.gov.uk: ${lastError}`);
    }
    if (res.status === 404) throw new DirectLegislationError(`not found on legislation.gov.uk: ${url}`);
    if (res.status >= 500 && attempt === 0) continue;
    if (!res.ok) throw new DirectLegislationError(`legislation.gov.uk returned ${res.status} for ${url}`);

    const body = await res.text();
    // A firewall challenge is an HTML page served with a 200: report it, never parse it as legislation.
    if (WAF_CHALLENGE.test(body.slice(0, 8000))) {
      throw new DirectLegislationError(`legislation.gov.uk served an AWS WAF challenge page for ${url}`);
    }
    return body;
  }
  throw new DirectLegislationError(`legislation.gov.uk did not answer for ${url}`);
}

// ── search ───────────────────────────────────────────────────────────────────

export function searchUrl(args: { query: string; type?: string; year?: number }, fulltext: boolean): string {
  if (fulltext) {
    const params = new URLSearchParams({ text: args.query });
    if (args.type) params.set("type", args.type);
    if (typeof args.year === "number") params.set("year", String(args.year));
    return `${BASE}/search/data.feed?${params.toString()}`;
  }
  const path = [args.type || "all"];
  if (args.type && typeof args.year === "number") path.push(String(args.year));
  return `${BASE}/${path.join("/")}/data.feed?${new URLSearchParams({ title: args.query }).toString()}`;
}

const ID_TYPE = /\/id\/([a-z]+)\//;
const ID_YEAR_NUMBER = /\/(\d{4})\/(\d+)\/?$/;

/** Atom feed -> hits shaped like the MCP's legislation_search hits.
 *
 * Year and number come from the ukm:Year / ukm:Number metadata, not the entry id: older Acts are identified by
 * regnal year (…/id/ukpga/Eliz2/1-2/20 is the Births and Deaths Registration Act 1953), but the Library needs the
 * calendar year to form …/ukpga/1953/20. */
export function parseFeed(xml: string, limit = 20, year?: number): UkLegislationSearchHit[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const hits: UkLegislationSearchHit[] = [];
  $("entry").each((_, entry) => {
    if (hits.length >= limit) return;
    const children = $(entry).children().toArray();
    const text = (name: string) => $(children.find((c) => c.type === "tag" && c.name === name)).text().trim();
    const meta = (name: string) =>
      $(children.find((c) => c.type === "tag" && c.name === name)).attr("Value") ?? "";

    const title = text("title");
    const id = text("id");
    const typeMatch = ID_TYPE.exec(id);
    if (!title || !typeMatch) return;

    let rowYear = meta("ukm:Year");
    let rowNumber = meta("ukm:Number");
    if (!rowYear || !rowNumber) {
      const tail = ID_YEAR_NUMBER.exec(id);
      if (!tail) return;
      [rowYear, rowNumber] = [tail[1], tail[2]];
    }
    const y = Number.parseInt(rowYear, 10);
    const n = Number.parseInt(rowNumber, 10);
    if (!Number.isFinite(y) || !Number.isFinite(n)) return;
    if (typeof year === "number" && y !== year) return;

    hits.push({ title, type: typeMatch[1], year: y, number: n, score: null, url: `${BASE}/${typeMatch[1]}/${y}/${n}` });
  });
  return hits;
}

/** Search legislation.gov.uk: a title search first, then — if that finds nothing — a full-text search. */
export async function searchLegislationDirect(
  args: { query: string; type?: string; year?: number; limit?: number },
  fetchImpl: FetchLike = fetch,
): Promise<UkLegislationSearchResult> {
  const query = args.query.trim();
  const limit = args.limit ?? 20;
  for (const fulltext of [false, true]) {
    const hits = parseFeed(await fetchText(searchUrl({ ...args, query }, fulltext), fetchImpl), limit, args.year);
    if (hits.length) return { results: hits, total: hits.length };
  }
  return { results: [], total: 0 };
}

// ── one section ──────────────────────────────────────────────────────────────

// Elements that start/end a block of text; everything else (Addition, Substitution, Emphasis …) is inline.
const BLOCK = new Set([
  "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P1para", "P2para", "P3para", "P4para", "P5para", "P6para",
  "Pnumber", "Para", "Title", "ListItem", "OrderedList", "UnorderedList", "Text", "BlockAmendment",
]);

/** Plain text of a provision in reading order: block elements are separated by spaces, inline ones (amendments such as
 * <Addition>) run straight on, so "section 29A</Addition>." keeps its full stop. */
function flatten(node: XmlNode | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  const walk = (n: XmlNode): void => {
    if (n.type === "text") {
      parts.push(n.data ?? "");
      return;
    }
    if (n.type !== "tag") return;
    const block = BLOCK.has(n.name ?? "");
    if (block) parts.push(" ");
    (n.children ?? []).forEach(walk);
    if (block) parts.push(" ");
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

const EXTENT_NAMES: Record<string, string> = { E: "England", W: "Wales", S: "Scotland", "N.I.": "Northern Ireland" };

export function parseSection(xml: string, maxChars = 10_000): UkLegislationSectionResult {
  const $ = cheerio.load(xml, { xmlMode: true });
  const group = $("P1group").first();
  if (!group.length) throw new DirectLegislationError("no section text in the legislation.gov.uk response");

  const heading = flatten($(group).children("Title").get(0) as unknown as XmlNode);
  const p1 = $(group).children("P1").first();
  const bodyNode = (p1.length ? p1.get(0) : group.get(0)) as unknown as XmlNode;
  const sectionNumber = p1.length ? flatten(p1.children("Pnumber").get(0) as unknown as XmlNode) : "";

  // Same layout the MCP returned: "<heading> <section no.> <1> <text> <2> <text> …" — the body already starts with
  // the section number and the subsection numbers, so only the heading goes in front.
  let content = `${heading} ${flatten(bodyNode)}`.trim();
  const truncated = content.length > maxChars;
  if (truncated) content = content.slice(0, maxChars).trimEnd();

  const extent = (group.attr("RestrictExtent") ?? "")
    .split("+")
    .map((code) => EXTENT_NAMES[code.trim()])
    .filter((name): name is string => !!name);
  const status = (group.attr("Status") ?? "").toLowerCase();

  return {
    title: heading || null,
    section_number: sectionNumber || null,
    content,
    content_truncated: truncated,
    // Not asserted when legislation.gov.uk does not say: a missing Status is not proof the section is in force.
    in_force: status === "repealed" || status === "prospective" ? false : null,
    extent,
    version_date: null,
  };
}

export async function getLegislationSectionDirect(
  args: { type: string; year: number; number: number; section: string; maxChars?: number },
  fetchImpl: FetchLike = fetch,
): Promise<UkLegislationSectionResult> {
  const url = `${BASE}/${args.type}/${args.year}/${args.number}/section/${encodeURIComponent(args.section)}/data.xml`;
  return parseSection(await fetchText(url, fetchImpl), args.maxChars);
}
