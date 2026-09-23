import axios from "axios";
import logger from "./logger";
import type { RelatedCase } from "./chatWonder";

const titleCache = new Map<string, string | null>();

/** legislation.gov.uk URL -> its work-level path, e.g. ".../uksi/2021/365/section/3" -> "uksi/2021/365". */
function legislationWorkPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("legislation.gov.uk")) return null;
    const [type, year, number] = u.pathname.split("/").filter(Boolean);
    return type && year && number && /^\d+$/.test(year) ? `${type}/${year}/${number}` : null;
  } catch {
    return null;
  }
}

async function fetchLegislationTitle(workPath: string): Promise<string | null> {
  if (titleCache.has(workPath)) return titleCache.get(workPath)!;
  try {
    const { data } = await axios.get<string>(`https://www.legislation.gov.uk/${workPath}/contents/data.xml`, {
      timeout: 8_000,
      responseType: "text",
    });
    const title = /<dc:title>([^<]+)<\/dc:title>/.exec(data)?.[1]?.trim() ?? null;
    titleCache.set(workPath, title);
    return title;
  } catch (err) {
    // Not cached — a transient failure shouldn't pin "no title" for the life of the process.
    logger.warn("Related case title lookup failed", { err, workPath });
    return null;
  }
}

/**
 * Chat Wonder sometimes returns a related item with only a URL (title/case_number/ra_number all
 * null). For legislation.gov.uk links, fill in the official title (e.g. "The Abortion (Northern
 * Ireland) Regulations 2021") so the UI shows a real name instead of a bare link. Also collapses
 * duplicate URLs, since the same section is often cited more than once. Lookup failures leave the
 * item untouched.
 */
export async function enrichRelatedCaseTitles(items: RelatedCase[]): Promise<RelatedCase[]> {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = item.url ?? `${item.title}|${item.case_number}|${item.ra_number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return Promise.all(
    unique.map(async (item) => {
      if (item.title?.trim() || item.case_number?.trim() || item.ra_number?.trim() || !item.url) return item;
      const workPath = legislationWorkPath(item.url);
      if (!workPath) return item;
      const title = await fetchLegislationTitle(workPath);
      return title ? { ...item, title } : item;
    }),
  );
}
