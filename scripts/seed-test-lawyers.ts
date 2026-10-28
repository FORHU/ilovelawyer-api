/**
 * Local and dev testing only: seeds 100 UK solo lawyer accounts with a deliberate spread of
 * statuses, regulators, "Qualified in" and practice areas, for testing matching, the admin lists
 * and the lawyer app. Run it after `prisma migrate reset` (or `prisma:seed`): it needs the UK
 * tenant, its tiers and the practice and case areas.
 *
 *   npm run seed:test-lawyers              create the 100, or put them back as seeded
 *   npm run seed:test-lawyers -- --clean   delete every seeded lawyer (emails @seed.example.com)
 *
 * Everything comes from a fixed random seed, so every run makes the same people: uk.lawyer.042 is
 * always the same lawyer. A run also deletes any other seeded lawyer (an older PH one, say), so the
 * database holds exactly these 100. Each signs in with SEED_LAWYER_PASSWORD (or the fallback
 * below). Nobody gets a card or a subscription, so claiming a request still needs a card added by
 * hand.
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import { BCRYPT_SALT_ROUNDS, TERMS_VERSION } from "../src/constants/auth.constants";
import { USERS_LIST_VERSION_KEY } from "../src/constants/admin.constants";
import { UK_JURISDICTIONS, type LawyerRegulator, type UkJurisdiction } from "../src/types/client-handoff";
import PaymentPlanSvc from "../src/services/payment-plan.service";

// A subdomain of the reserved example.com: Joi's email check rejects the reserved `.test` TLD, so
// the API refused to sign these lawyers in, and other seeds already use plain @example.com.
const EMAIL_DOMAIN = "seed.example.com";
// The domain seeded lawyers used before; still deleted so a re-seed or --clean removes them.
const LEGACY_EMAIL_DOMAIN = "seed.test";
const PASSWORD = process.env.SEED_LAWYER_PASSWORD || "Seed-Lawyer-123!";
const COUNT = 100;
const SITE = "UK";
const DAY_MS = 24 * 60 * 60 * 1000;

type Status = "VERIFIED" | "PENDING" | "REJECTED" | "UNSUBMITTED";
type Tier = "standard" | "pro" | "max";

// ── Layout: which numbers are which ──────────────────────────────────────────────────────────────

const statusOf = (n: number): Status => (n <= 70 ? "VERIFIED" : n <= 85 ? "PENDING" : n <= 90 ? "REJECTED" : "UNSUBMITTED");
const HEAVY = [1, 2, 3];
const MAX_TIER = [1, 2];
const PRO_COUNT = 5;

/** Verified lawyers 1–70: who can actually receive requests. */
type Availability = "accepting" | "paused" | "off" | "capacity";
const availabilityOf = (n: number): Availability => (n <= 58 ? "accepting" : n <= 63 ? "paused" : n <= 67 ? "off" : "capacity");

/** What each UNSUBMITTED lawyer (91–100) is missing, by number. */
const MISSING: Record<number, string[]> = {
  91: ["regulator"],
  92: ["regulator"],
  93: ["registrationNumber"],
  94: ["registrationNumber"],
  95: ["qualifiedJurisdictions"],
  96: ["qualifiedJurisdictions"],
  97: ["practiceAreas"],
  98: ["practiceAreas"],
  99: ["regulator", "registrationNumber"],
  100: ["qualifiedJurisdictions", "practiceAreas"],
};

// ── Regulators and jurisdictions ─────────────────────────────────────────────────────────────────

const [EW, SCO, NI] = UK_JURISDICTIONS;
const REGULATOR_NAMES: Record<LawyerRegulator, string> = { SRA: "the SRA", LSS: "the Law Society of Scotland", LSNI: "the Law Society of Northern Ireland" };

/** The 12 realistic combinations (home jurisdiction plus 0–2 more) and how many lawyers get each:
 * SRA 55, LSS 25, LSNI 20. Each has at least 3, all of whom are verified. */
const COMBOS: { regulator: LawyerRegulator; jurisdictions: UkJurisdiction[]; count: number }[] = [
  { regulator: "SRA", jurisdictions: [EW], count: 40 },
  { regulator: "SRA", jurisdictions: [EW, SCO], count: 6 },
  { regulator: "SRA", jurisdictions: [EW, NI], count: 5 },
  { regulator: "SRA", jurisdictions: [EW, SCO, NI], count: 4 },
  { regulator: "LSS", jurisdictions: [SCO], count: 15 },
  { regulator: "LSS", jurisdictions: [SCO, EW], count: 4 },
  { regulator: "LSS", jurisdictions: [SCO, NI], count: 3 },
  { regulator: "LSS", jurisdictions: [SCO, EW, NI], count: 3 },
  { regulator: "LSNI", jurisdictions: [NI], count: 10 },
  { regulator: "LSNI", jurisdictions: [NI, EW], count: 4 },
  { regulator: "LSNI", jurisdictions: [NI, SCO], count: 3 },
  { regulator: "LSNI", jurisdictions: [NI, EW, SCO], count: 3 },
];
const MIN_PER_COMBO = 3;

// ── Practice areas ───────────────────────────────────────────────────────────────────────────────

/** Areas mapped to these case types are picked three times as often. */
const COMMON_CASE_AREAS = new Set(["FAMILY", "EMPLOYMENT", "PROPERTY", "CRIMINAL", "IMMIGRATION"]);
/** Verified lawyers holding each practice area, at least. */
const MIN_HOLDERS = 3;
/** Accepting lawyers for each jurisdiction × client case type, at least. */
const MIN_PER_PAIR = 2;

// ── People ───────────────────────────────────────────────────────────────────────────────────────

const FIRST = ["Olivia", "Amelia", "Isla", "Ava", "Mia", "Grace", "Freya", "Sophie", "Emily", "Charlotte", "Eilidh", "Niamh", "Ciara", "Aoife", "Priya", "Aisha", "Zara", "Hannah", "Lucy", "Ruth", "Oliver", "George", "Harry", "Jack", "Noah", "Callum", "Euan", "Ruaridh", "Conor", "Ciaran", "Liam", "Rhys", "Owen", "Arjun", "Imran", "Daniel", "Thomas", "James", "Samuel", "Matthew"];
const LAST = ["Smith", "Jones", "Taylor", "Brown", "Williams", "Wilson", "Johnson", "Davies", "Robertson", "Campbell", "Stewart", "MacDonald", "Murray", "Reid", "O'Neill", "Murphy", "Kelly", "Doherty", "Quinn", "McCann", "Evans", "Thomas", "Roberts", "Hughes", "Patel", "Khan", "Ahmed", "Singh", "Clarke", "Walker", "Wright", "Green", "Hall", "Wood", "Harris", "Martin", "Cooper", "King", "Baker", "Hill"];
const EXTRA_LANGUAGES = ["Welsh", "Polish", "Urdu", "Punjabi", "French", "Spanish", "Scottish Gaelic", "Irish", "Gujarati", "Arabic"];
/** First-consultation fees in pence; null is "not set". */
const FEES = [null, 0, 5000, 7500, 10000, 15000, 20000, 25000];
const REJECTIONS = [
  "We couldn't find this registration number on the register. Check it and resubmit.",
  "The name on the register doesn't match the name on your account.",
  "The register shows your practising certificate as not current.",
];

// ── Random, from a fixed seed ────────────────────────────────────────────────────────────────────

/** mulberry32: small, fast and the same everywhere. */
function rngFrom(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = ReturnType<typeof rngFrom>;
const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]) => items[Math.floor(rng() * items.length)];
function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** `count` distinct numbers of `digits` digits. */
function uniqueNumbers(rng: Rng, count: number, digits: number): string[] {
  const seen = new Set<string>();
  while (seen.size < count) seen.add(String(int(rng, 10 ** (digits - 1), 10 ** digits - 1)));
  return [...seen];
}
const listOf = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// ── The plan for one lawyer, built in memory before anything is written ──────────────────────────

interface Area {
  id: string;
  name: string;
  caseArea: string | null;
}

interface Lawyer {
  n: number;
  email: string;
  username: string;
  name: string;
  status: Status;
  missing: string[];
  availability: Availability | null;
  heavy: boolean;
  tier: Tier;
  areaIds: Set<string>;
  regulator: LawyerRegulator | null;
  registrationNumber: string | null;
  jurisdictions: UkJurisdiction[];
  combo: string | null;
  languages: string[];
  feeMinor: number | null;
  createdAt: Date;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  verificationNote: string | null;
  pausedUntil: Date | null;
  capacityLimit: number | null;
}

const pad = (n: number) => String(n).padStart(3, "0");
const comboLabel = (regulator: LawyerRegulator, jurisdictions: UkJurisdiction[]) => `${regulator}: ${jurisdictions.join(" + ")}`;

function baseLawyers(rng: Rng, now: Date): Lawyer[] {
  return Array.from({ length: COUNT }, (_, i) => {
    const n = i + 1;
    const status = statusOf(n);
    const ago = (minDays: number, maxDays: number) => new Date(now.getTime() - int(rng, minDays, maxDays) * DAY_MS - int(rng, 0, 23) * 60 * 60 * 1000);
    const submittedAt = status === "UNSUBMITTED" ? null : status === "PENDING" ? ago(1, 20) : ago(5, 60);
    const createdAt = new Date((submittedAt ?? ago(1, 30)).getTime() - int(rng, 0, 3) * DAY_MS - 60 * 60 * 1000);
    const verifiedAt = submittedAt && status === "VERIFIED" ? new Date(Math.min(submittedAt.getTime() + int(rng, 1, 5) * DAY_MS, now.getTime() - 60 * 60 * 1000)) : null;
    const availability = status === "VERIFIED" ? availabilityOf(n) : null;
    return {
      n,
      email: `uk.lawyer.${pad(n)}@${EMAIL_DOMAIN}`,
      username: `uk-lawyer-${pad(n)}`,
      name: `${pick(rng, FIRST)} ${pick(rng, LAST)}`,
      status,
      missing: MISSING[n] ?? [],
      availability,
      heavy: HEAVY.includes(n),
      tier: MAX_TIER.includes(n) ? "max" : "standard",
      areaIds: new Set<string>(),
      regulator: null,
      registrationNumber: null,
      jurisdictions: [],
      combo: null,
      languages: ["English", ...(rng() < 0.35 ? [pick(rng, EXTRA_LANGUAGES)] : [])],
      feeMinor: pick(rng, FEES),
      createdAt,
      submittedAt,
      verifiedAt,
      verificationNote: status === "REJECTED" ? pick(rng, REJECTIONS) : null,
      pausedUntil: availability === "paused" ? new Date(now.getTime() + int(rng, 7, 30) * DAY_MS) : null,
      capacityLimit: availability === "capacity" ? 1 : null,
    };
  });
}

/** Regulator, number and "Qualified in": 3 verified lawyers per combination first, then the rest. */
function assignRegistration(lawyers: Lawyer[], rng: Rng) {
  const guaranteed = COMBOS.flatMap((c) => Array.from({ length: MIN_PER_COMBO }, () => c));
  const rest = shuffle(rng, COMBOS.flatMap((c) => Array.from({ length: c.count - MIN_PER_COMBO }, () => c)));
  const verified = shuffle(rng, lawyers.filter((l) => l.status === "VERIFIED"));
  const order = [...verified, ...shuffle(rng, lawyers.filter((l) => l.status !== "VERIFIED"))];
  const combos = [...guaranteed, ...rest];
  const numbers = uniqueNumbers(rng, lawyers.length, 6);
  order.forEach((l, i) => {
    const c = combos[i];
    l.combo = comboLabel(c.regulator, c.jurisdictions);
    l.regulator = l.missing.includes("regulator") ? null : c.regulator;
    l.registrationNumber = l.missing.includes("registrationNumber") ? null : numbers[i];
    l.jurisdictions = l.missing.includes("qualifiedJurisdictions") ? [] : [...c.jurisdictions];
  });
}

/** 1–4 areas each (12+ for the heavy lawyers), weighted toward the common case types. */
function assignAreas(lawyers: Lawyer[], areas: Area[], rng: Rng) {
  const weight = (a: Area) => (a.caseArea && COMMON_CASE_AREAS.has(a.caseArea) ? 3 : 1);
  for (const l of lawyers) {
    if (l.missing.includes("practiceAreas")) continue;
    const r = rng();
    const count = l.heavy ? Math.min(areas.length, int(rng, 12, 16)) : r < 0.3 ? 1 : r < 0.65 ? 2 : r < 0.85 ? 3 : 4;
    const pool = [...areas];
    while (l.areaIds.size < count && pool.length) {
      const total = pool.reduce((sum, a) => sum + weight(a), 0);
      let at = rng() * total;
      const index = pool.findIndex((a) => (at -= weight(a)) < 0);
      l.areaIds.add(pool.splice(index === -1 ? pool.length - 1 : index, 1)[0].id);
    }
  }
}

/** The lawyer with the fewest areas among `candidates`, ties broken at random. */
function lightest(candidates: Lawyer[], rng: Rng): Lawyer | undefined {
  return shuffle(rng, candidates).sort((a, b) => a.areaIds.size - b.areaIds.size)[0];
}

/** Every jurisdiction × client case type has MIN_PER_PAIR accepting lawyers: tops up the lightest
 * qualified lawyer with the least-held area mapped to that type. */
function coverPairs(lawyers: Lawyer[], areas: Area[], caseTypes: string[], rng: Rng) {
  const accepting = lawyers.filter((l) => l.availability === "accepting");
  const caseTypeOf = new Map(areas.map((a) => [a.id, a.caseArea]));
  const covers = (l: Lawyer, caseType: string) => [...l.areaIds].some((id) => caseTypeOf.get(id) === caseType);
  const held = (id: string) => lawyers.filter((l) => l.areaIds.has(id)).length;
  for (const j of UK_JURISDICTIONS) {
    for (const caseType of caseTypes) {
      const mapped = areas.filter((a) => a.caseArea === caseType);
      while (accepting.filter((l) => l.jurisdictions.includes(j) && covers(l, caseType)).length < MIN_PER_PAIR) {
        const lawyer = lightest(accepting.filter((l) => l.jurisdictions.includes(j) && !covers(l, caseType)), rng);
        if (!lawyer) throw new Error(`Not enough accepting lawyers qualified in ${j} to cover ${caseType}`);
        lawyer.areaIds.add([...mapped].sort((a, b) => held(a.id) - held(b.id))[0].id);
      }
    }
  }
}

/** Every practice area has MIN_HOLDERS verified holders. */
function coverAreas(lawyers: Lawyer[], areas: Area[], rng: Rng) {
  const verified = lawyers.filter((l) => l.status === "VERIFIED");
  for (const a of areas) {
    while (verified.filter((l) => l.areaIds.has(a.id)).length < MIN_HOLDERS) {
      lightest(verified.filter((l) => !l.areaIds.has(a.id)), rng)!.areaIds.add(a.id);
    }
  }
}

/** Pro goes to 5 accepting lawyers spread across regulators and combinations. */
function assignPro(lawyers: Lawyer[]) {
  const eligible = lawyers.filter((l) => l.availability === "accepting" && !HEAVY.includes(l.n));
  const regulators: LawyerRegulator[] = ["SRA", "LSS", "LSNI", "SRA", "LSS"];
  const used = new Set<string>();
  for (let i = 0; i < PRO_COUNT; i++) {
    const lawyer = eligible.find((l) => l.tier === "standard" && !used.has(l.combo!) && l.regulator === regulators[i]);
    if (!lawyer) continue;
    lawyer.tier = "pro";
    used.add(lawyer.combo!);
  }
}

function bioOf(l: Lawyer, areaNames: Map<string, string>): string {
  const areas = [...l.areaIds].map((id) => areaNames.get(id)!).slice(0, 4);
  const work = areas.length ? ` I practise in ${listOf(areas)}${l.areaIds.size > 4 ? ", among others" : ""}.` : "";
  const who = l.regulator ? `Solicitor regulated by ${REGULATOR_NAMES[l.regulator]}` : "Solicitor";
  const where = l.jurisdictions.length ? `, qualified in ${listOf(l.jurisdictions)}` : "";
  return `${who}${where}.${work} I explain where you stand in plain English and agree the fee before any work starts.`;
}

// ── Checks, then writing ─────────────────────────────────────────────────────────────────────────

async function plan(now: Date) {
  const rng = rngFrom(1001);
  const tenant = await prisma.tenant.findUnique({ where: { code: SITE } });
  if (!tenant) throw new Error("No UK tenant: run `npm run prisma:seed` first");
  const areas: Area[] = await prisma.practiceArea.findMany({ where: { country: SITE, isActive: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, caseArea: true } });
  if (areas.length === 0) throw new Error("No active UK practice areas: run the migrations and `npm run prisma:seed` first");
  const caseTypes = (await prisma.caseArea.findMany({ where: { country: SITE, isActive: true }, orderBy: { sortOrder: "asc" }, select: { code: true } })).map((c) => c.code);
  const unrouted = caseTypes.filter((c) => !areas.some((a) => a.caseArea === c));
  if (unrouted.length) throw new Error(`No active UK practice area maps to ${unrouted.join(", ")}: map one in the admin, then run this again`);

  const lawyers = baseLawyers(rng, now);
  assignRegistration(lawyers, rng);
  assignAreas(lawyers, areas, rng);
  coverPairs(lawyers, areas, caseTypes, rng);
  coverAreas(lawyers, areas, rng);
  assignPro(lawyers);

  return { tenantId: tenant.id, lawyers, areas, caseTypes, tiers: await tiersFor(tenant.id) };
}
type Plan = Awaited<ReturnType<typeof plan>>;

/** The tenant's tier for each code; a missing or switched-off one falls back to the default. */
async function tiersFor(tenantId: string): Promise<Record<Tier, string>> {
  const fallback = await PaymentPlanSvc.defaultIdForTenant(tenantId);
  if (!fallback) throw new Error("The UK tenant has no active subscription tier: run `npm run prisma:seed` first");
  const plans = await prisma.paymentPlan.findMany({ where: { tenantId, planType: "B2B_SUBSCRIPTION", isActive: true }, select: { id: true, code: true } });
  const idOf = (code: Tier) => {
    const id = plans.find((p) => p.code === code)?.id;
    if (!id && code !== "standard") console.warn(`  No active "${code}" tier, so those lawyers get the default tier`);
    return id ?? fallback;
  };
  return { standard: idOf("standard"), pro: idOf("pro"), max: idOf("max") };
}

async function write(p: Plan, passwordHash: string, now: Date) {
  const areaNames = new Map(p.areas.map((a) => [a.id, a.name]));
  for (const l of p.lawyers) {
    const userData = {
      username: l.username,
      password: passwordHash,
      name: l.name,
      role: "LAWYER" as const,
      tenantId: p.tenantId,
      isEmailVerified: true,
      approvalStatus: "ACTIVE" as const,
      onboardingCompleted: true,
      setupCompletedAt: l.createdAt,
      soloChosenAt: l.createdAt,
      termsAcceptedAt: l.createdAt,
      termsVersion: TERMS_VERSION,
      paymentPlanId: p.tiers[l.tier],
      allowancePeriodStart: now,
    };
    const user = await prisma.user.upsert({
      where: { email: l.email },
      create: { email: l.email, createdAt: l.createdAt, ...userData },
      update: userData,
    });
    const profile = {
      country: SITE,
      bio: bioOf(l, areaNames),
      languages: l.languages,
      firstConsultationFeeMinor: l.feeMinor,
      acceptingRequests: l.availability === "accepting" || l.availability === "paused" || l.availability === "capacity",
      enabledByOrganization: true,
      pausedUntil: l.pausedUntil,
      capacityLimit: l.capacityLimit,
      verificationStatus: l.status,
      verificationNote: l.verificationNote,
      verifiedAt: l.verifiedAt,
      submittedAt: l.submittedAt,
    };
    const registration = { regulator: l.regulator, registrationNumber: l.registrationNumber, qualifiedJurisdictions: l.jurisdictions };
    await prisma.$transaction([
      prisma.lawyerClientProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...profile }, update: profile }),
      prisma.lawyerUkRegistration.upsert({ where: { userId: user.id }, create: { userId: user.id, ...registration }, update: registration }),
      prisma.lawyerPracticeArea.deleteMany({ where: { userId: user.id } }),
      prisma.lawyerPracticeArea.createMany({ data: [...l.areaIds].map((practiceAreaId) => ({ userId: user.id, practiceAreaId })) }),
    ]);
  }
}

// ── The summary ──────────────────────────────────────────────────────────────────────────────────

function countBy<T>(items: T[], key: (item: T) => string | null): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()];
}
const emailsOf = (lawyers: Lawyer[]) => lawyers.map((l) => l.email.replace(`@${EMAIL_DOMAIN}`, "")).join(", ") || "none";

function summarise({ lawyers, areas, caseTypes }: Plan) {
  const verified = lawyers.filter((l) => l.status === "VERIFIED");
  console.log(`\n══ UK: ${lawyers.length} lawyers, all solo ══`);
  console.log(`Status: ${countBy(lawyers, (l) => l.status).map(([k, v]) => `${k} ${v}`).join(" · ")}  (001–070 verified, 071–085 pending, 086–090 rejected, 091–100 unsubmitted)`);
  console.log(`Tiers: ${countBy(lawyers, (l) => l.tier).map(([k, v]) => `${k} ${v}`).join(" · ")}  (pro: ${emailsOf(lawyers.filter((l) => l.tier === "pro"))}; max: ${emailsOf(lawyers.filter((l) => l.tier === "max"))})`);
  console.log(`Heavy (12+ areas): ${emailsOf(lawyers.filter((l) => l.heavy))}`);

  console.log("\nRegulator and Qualified in (all / verified):");
  for (const c of COMBOS) {
    const label = comboLabel(c.regulator, c.jurisdictions);
    console.log(`  ${label.padEnd(52)} ${String(lawyers.filter((l) => l.combo === label).length).padStart(3)} / ${verified.filter((l) => l.combo === label).length}`);
  }
  console.log("\nVerified, by availability:");
  for (const a of ["accepting", "paused", "off", "capacity"] as Availability[]) {
    const group = verified.filter((l) => l.availability === a);
    console.log(`  ${a.padEnd(10)} ${String(group.length).padStart(3)}${a === "accepting" ? "" : `  ${emailsOf(group)}`}`);
  }
  console.log("  (paused: accepting but paused until a future date; off: accepting switched off; capacity: limit of 1)");

  const caseTypeOf = new Map(areas.map((a) => [a.id, a.caseArea]));
  const accepting = verified.filter((l) => l.availability === "accepting");
  const short: string[] = [];
  let pairs = 0;
  for (const j of UK_JURISDICTIONS) {
    for (const c of caseTypes) {
      pairs++;
      const n = accepting.filter((l) => l.jurisdictions.includes(j) && [...l.areaIds].some((id) => caseTypeOf.get(id) === c)).length;
      if (n < MIN_PER_PAIR) short.push(`${j} × ${c} (${n})`);
    }
  }
  console.log(`\nCoverage: ${pairs - short.length}/${pairs} jurisdiction × client case type pairs have ${MIN_PER_PAIR}+ accepting lawyers`);
  if (short.length) throw new Error(`Coverage check failed: ${short.join(", ")}`);

  console.log("\nPractice areas (verified holders / all holders):");
  for (const a of areas) {
    console.log(`  ${a.name.padEnd(34)} ${String(verified.filter((l) => l.areaIds.has(a.id)).length).padStart(3)} / ${lawyers.filter((l) => l.areaIds.has(a.id)).length}`);
  }

  console.log("\nUnsubmitted, and what each is missing:");
  for (const l of lawyers.filter((x) => x.status === "UNSUBMITTED")) console.log(`  ${l.email.replace(`@${EMAIL_DOMAIN}`, "")}  ${l.missing.join(", ")}`);
}

/** The admin's user list is cached per version (see AuthRepo); bump it so the changes show. */
async function bustUsersList() {
  for (let i = 0; i < 20 && !(await redis.ping()); i++) await new Promise((r) => setTimeout(r, 100));
  if (await redis.ping()) await redis.incr(USERS_LIST_VERSION_KEY);
  else console.warn("Redis isn't reachable: the admin's user list may show cached pages for a few minutes.");
}

/** Seeded lawyers (by email domain), except those in `keep`. */
async function deleteSeeded(keep: string[] = []) {
  const { count } = await prisma.user.deleteMany({
    where: {
      role: "LAWYER",
      email: { notIn: keep },
      OR: [EMAIL_DOMAIN, LEGACY_EMAIL_DOMAIN].map((domain) => ({ email: { endsWith: `@${domain}` } })),
    },
  });
  return count;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed test lawyers with NODE_ENV=production");
  if (process.argv.includes("--clean")) {
    const count = await deleteSeeded();
    await bustUsersList();
    console.log(`Deleted ${count} seeded lawyers (@${EMAIL_DOMAIN}).`);
    return;
  }

  const now = new Date();
  // Plan in full first, so a failed check writes nothing.
  const p = await plan(now);
  summarise(p);

  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_SALT_ROUNDS);
  const stale = await deleteSeeded(p.lawyers.map((l) => l.email));
  await write(p, passwordHash, now);
  await bustUsersList();

  console.log(`\nSeeded ${p.lawyers.length} UK lawyers. Sign in as e.g. uk.lawyer.001@${EMAIL_DOMAIN}`);
  if (stale) console.log(`Deleted ${stale} other seeded lawyers that aren't in this list (e.g. older PH ones).`);
  // A password from the environment is never printed: on dev this output lands in SSM and the
  // GitHub job summary.
  console.log(process.env.SEED_LAWYER_PASSWORD ? "Password: the value of SEED_LAWYER_PASSWORD" : `Password: ${PASSWORD} (fallback; set SEED_LAWYER_PASSWORD to change it)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
