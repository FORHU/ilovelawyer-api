import LawyerProfileRepo from "../repositories/lawyer-profile.repository";
import ClientRequestMatchingSvc, { caseAreasOf } from "./client-request-matching.service";
import CaseAreaSvc from "./case-area.service";
import HttpError from "../utils/http-error";
import { getStableProxyFileUrl } from "../utils/s3";
import type { LawyerSort, ListClientLawyersQuery } from "../validation/client-lawyer.validation";

type MarketplaceRow = Awaited<ReturnType<typeof LawyerProfileRepo.findForMarketplace>>[number];
type Rating = { average: number; count: number };

/** Languages the marketplace filters on by name; "Other" is any language but these. */
const NAMED_LANGUAGES = ["english", "welsh"];

const norm = (s: string) => s.trim().toLowerCase();

function organizationOf(row: MarketplaceRow) {
  const org = row.user.organizationMemberships[0]?.organization;
  // A solo lawyer has no organization, so no firm (nor did a client-era personal workspace).
  return org && !org.isPersonal ? org : null;
}

function speaksAny(row: MarketplaceRow, wanted: string[]) {
  if (wanted.length === 0) return true;
  const spoken = row.languages.map(norm);
  return wanted.map(norm).some((w) => (w === "other" ? spoken.some((l) => !NAMED_LANGUAGES.includes(l)) : spoken.includes(w)));
}

function matchesQuery(row: MarketplaceRow, query: ListClientLawyersQuery) {
  if (query.area && !caseAreasOf(row.practiceAreas).includes(query.area)) return false;
  if (query.jurisdiction && !row.qualifiedJurisdictions.includes(query.jurisdiction)) return false;
  if (query.maxConsultationMinor !== undefined) {
    // No first consultation offered: nothing within any limit.
    if (row.firstConsultationFeeMinor === null || row.firstConsultationFeeMinor > query.maxConsultationMinor) return false;
  }
  if (!speaksAny(row, query.languages)) return false;
  const q = norm(query.q);
  if (q) {
    const org = organizationOf(row);
    const haystack = [row.user.name ?? "", org?.name ?? "", org?.city ?? ""].join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function sorter(sort: LawyerSort, caseArea: string | undefined, ratings: Map<string, Rating>) {
  const rating = (r: MarketplaceRow) => ratings.get(r.userId)?.average ?? -1;
  const reviews = (r: MarketplaceRow) => ratings.get(r.userId)?.count ?? 0;
  // No first consultation offered sorts after every price.
  const fee = (r: MarketplaceRow) => r.firstConsultationFeeMinor ?? Number.MAX_SAFE_INTEGER;
  const fits = (r: MarketplaceRow) => (caseArea && caseAreasOf(r.practiceAreas).includes(caseArea) ? 1 : 0);
  const byRating = (a: MarketplaceRow, b: MarketplaceRow) => rating(b) - rating(a) || reviews(b) - reviews(a);
  const by: Record<LawyerSort, (a: MarketplaceRow, b: MarketplaceRow) => number> = {
    match: (a, b) => fits(b) - fits(a) || byRating(a, b),
    rating: byRating,
    price: (a, b) => fee(a) - fee(b) || byRating(a, b),
  };
  // Same order every time for equals, so pages don't shuffle.
  return (a: MarketplaceRow, b: MarketplaceRow) => by[sort](a, b) || (a.user.name ?? "").localeCompare(b.user.name ?? "") || a.userId.localeCompare(b.userId);
}

/** A lawyer as the marketplace lists them: the public profile the client sees on a quote
 * (ClientRequestSvc's lawyerDto), plus their town and their clients' ratings. */
function lawyerDto(row: MarketplaceRow, rating: Rating | undefined) {
  const org = organizationOf(row);
  return {
    id: row.userId,
    name: row.user.name ?? "",
    avatarUrl: row.user.avatar?.s3Key ? getStableProxyFileUrl(row.user.avatar.s3Key) : null,
    firmName: org?.name ?? null,
    town: org?.city ?? null,
    regulator: row.regulator,
    registrationNumber: row.registrationNumber,
    // By name: the list is the lawyer's site's, which admins edit (PracticeArea).
    practiceAreas: row.practiceAreas.map((a) => a.name),
    // The client case areas they take, for matching the client's own case.
    caseAreas: caseAreasOf(row.practiceAreas),
    qualifiedJurisdictions: row.qualifiedJurisdictions,
    languages: row.languages,
    bio: row.bio,
    firstConsultationFee: row.firstConsultationFeeMinor === null ? null : { amountMinor: row.firstConsultationFeeMinor, currency: "GBP" },
    verifiedAt: row.verifiedAt,
    rating: rating ? Math.round(rating.average * 10) / 10 : null,
    reviewCount: rating?.count ?? 0,
  };
}

/** How many reviews with a comment a profile shows, newest first. */
const PROFILE_REVIEWS = 10;

/** The client app's lawyer marketplace (GET /api/client/lawyers): verified UK lawyers who are taking
 * requests (ClientRequestMatchingSvc.isAvailable), filtered and ordered as the client asks. */
export default class ClientLawyerSvc {
  /**
   * One lawyer's profile (GET /api/client/lawyers/:id): what the list shows, plus how their ratings
   * spread and their clients' latest comments, shown without the client's name. A verified lawyer
   * who isn't taking requests right now is still shown, `available` false, so an old link still
   * opens; 404 for anyone else.
   */
  static async get(id: string, now: Date = new Date()) {
    const [row] = await LawyerProfileRepo.findForMarketplace(id);
    if (!row) throw new HttpError("That lawyer isn't listed.", 404, "LAWYER_NOT_FOUND");
    const [feedback, label] = await Promise.all([LawyerProfileRepo.feedbackFor(id), CaseAreaSvc.labeller()]);
    const rating = feedback.length ? { average: feedback.reduce((sum, f) => sum + f.rating, 0) / feedback.length, count: feedback.length } : undefined;
    return {
      ...lawyerDto(row, rating),
      available: ClientRequestMatchingSvc.isAvailable(row, now),
      // Count of ratings at 5, 4, 3, 2, 1 stars.
      ratingBreakdown: [5, 4, 3, 2, 1].map((stars) => feedback.filter((f) => f.rating === stars).length),
      reviews: feedback
        .filter((f) => f.comment?.trim())
        .slice(0, PROFILE_REVIEWS)
        .map((f) => ({ rating: f.rating, comment: f.comment!.trim(), caseAreas: label(f.caseAreas).map((a) => a.name), createdAt: f.createdAt })),
    };
  }

  static async list(query: ListClientLawyersQuery, now: Date = new Date()) {
    const available = (await LawyerProfileRepo.findForMarketplace()).filter((row) => ClientRequestMatchingSvc.isAvailable(row, now));
    const ratings = await LawyerProfileRepo.ratingsFor(available.map((r) => r.userId));
    const shown = available.filter((row) => matchesQuery(row, query)).sort(sorter(query.sort, query.caseArea, ratings));
    const page = shown.slice((query.page - 1) * query.limit, query.page * query.limit);
    return { total: shown.length, data: page.map((row) => lawyerDto(row, ratings.get(row.userId))) };
  }
}
