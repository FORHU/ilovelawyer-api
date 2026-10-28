import type { OAS3Definition, Operation, Parameter, Reference, Schema } from "swagger-jsdoc";
import {
  AI_BUDGET_STATES,
  CHARGE_KINDS,
  CHARGE_STATUSES,
  CLAIM_OUTCOMES,
  CLIENT_REQUEST_STATUSES,
  LAWYER_REGULATORS,
  LAWYER_VERIFICATION_STATUSES,
  QUOTE_TYPES,
  RELEASE_REASONS,
  REQUEST_URGENCIES,
  UK_JURISDICTIONS,
} from "./types/client-handoff";
import { LAWYER_COUNTRIES, LAWYER_REJECTION_REASONS } from "./constants/lawyer-application.constants";

/** A case's areas, by name (CaseArea). */
const caseAreaNames = (description = "The case's areas by name, one or more"): Schema => ({ type: "array", items: { type: "string" }, description, example: ["Employment"] });

/**
 * The UK client-to-lawyer hand-off API contract (ilovelawyer-api#503), merged into swagger.ts.
 * Each operation says which issue builds it. Until it lands it carries `x-implemented: false`, so
 * the frontends can mock it from /api-docs.json; when it lands, mark it `built: true`. Values and socket events: types/client-handoff.ts.
 * Data model: docs/adr/0016-client-app-shares-the-uk-api.md.
 */

type Paths = NonNullable<OAS3Definition["paths"]>;
type Schemas = NonNullable<NonNullable<OAS3Definition["components"]>["schemas"]>;
type Tags = NonNullable<OAS3Definition["tags"]>;
type S = Schema | Reference;

const CLIENT_TAG = "Lawyer Requests (client app)";
const LAWYER_TAG = "Client Requests (lawyer app)";
const BILLING_TAG = "Client Request Billing (lawyer app)";
const ADMIN_TAG = "Admin: Client Requests";

const ref = (name: string): Reference => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: S) => ({ "application/json": { schema } });
const ok = (description: string, schema?: S) => (schema ? { description, content: json(schema) } : { description });
const err = (description: string) => ({ description, content: json(ref("Error")) });
const page = (item: string): Schema => ({
  type: "object",
  properties: { total: { type: "integer" }, data: { type: "array", items: ref(item) } },
});
const enumOf = (values: readonly string[], description?: string): Schema => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const money = (description?: string): S => ({ ...ref("Money"), ...(description ? { description } : {}) });
const dateTime = (description?: string, nullable = false): Schema => ({
  type: "string",
  format: "date-time",
  ...(nullable ? { nullable: true } : {}),
  ...(description ? { description } : {}),
});

const idParam = (name = "id"): Parameter => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });
const pageParams: Parameter[] = [
  { name: "page", in: "query", schema: { type: "integer", default: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
];
/** A thread is short and read whole: up to 200 a page, 100 by default (#517). */
const threadParams: Parameter[] = [
  { name: "page", in: "query", schema: { type: "integer", default: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 200 } },
];
const threadPage: Schema = {
  type: "object",
  properties: {
    total: { type: "integer" },
    unread: { type: "integer", description: "The other side's messages since you last read the thread (POST .../messages/read, or your own last post)" },
    data: { type: "array", items: ref("EngagementMessage") },
  },
};

interface Op {
  tag: string;
  issue: string;
  /** The issue has landed: no "planned" marker. */
  built?: boolean;
  summary: string;
  description?: string;
  parameters?: Parameter[];
  body?: Schema;
  responses: Record<number, object>;
}

/** One operation, planned unless `built`. Every hand-off route needs a session, so 401 is added to all. */
function op({ tag, issue, built, summary, description, parameters, body, responses }: Op): Operation {
  const status = built ? `Built in ${issue}.` : `**Planned (${issue}), not implemented yet.**`;
  return {
    tags: [tag],
    summary,
    description: `${status}${description ? `\n\n${description}` : ""}`,
    "x-implemented": !!built,
    security: [{ bearerAuth: [] }],
    ...(parameters ? { parameters } : {}),
    ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
    responses: { ...responses, 401: err("Not signed in") },
  };
}

const NOT_FOUND = err("No such request, or not one you can see");
const BAD_STATUS = err("INVALID_REQUEST_STATUS: not allowed in the request's current status (details.status)");
const LAWYER_ONLY = err("NOT_UK_TENANT or LAWYER_NOT_VERIFIED, or the account is not a lawyer");

export const clientHandoffTags: Tags = [
  {
    name: CLIENT_TAG,
    description: [
      "Called by ilovelawyer-client (`USER` accounts) under `/api/client`, next to its cases: client accounts only, and no `X-Organization-Id`. Asking for a lawyer on one of the client's own UK cases, reviewing the quote, the engagement thread and feedback.",
      "",
      "Status flow: `REQUESTED → ROUTED → CLAIMED → QUOTED → CONFIRMED → ENGAGED → CLOSED`, or `EXPIRED` / `WITHDRAWN`. Declining a quote sends the request back to `ROUTED`. The client sees `ROUTED` and `CLAIMED` as one state, \"Finding a lawyer\". Either side can end an engagement.",
      "",
      "Socket events (on the existing connection, user room; refetch on receipt):",
      "",
      "| Event | Payload | When |",
      "| --- | --- | --- |",
      "| `client-request:updated` | `{ requestId, status, updatedAt }` | Any status change |",
      "| `engagement:message` | `{ requestId, message }` | The lawyer posts in the thread |",
    ].join("\n"),
  },
  {
    name: LAWYER_TAG,
    description: [
      "Called by ilovelawyer-app on the UK tenant (`LAWYER` accounts). Profile settings, the Client Requests inbox, claim and pass, the conflict check, the quote, the engagement, and organization routing.",
      "",
      "A lawyer matches a request when they are verified, accepting requests, not paused, under capacity, and qualified for the case's practice area and UK jurisdiction. The first claim wins a 24h hold. A release, lapse or client decline sends the request back to the pool, and the lawyer who held it doesn't see it again.",
      "",
      "Once `ENGAGED`, the client's case opens through the existing case routes (`/my-cases/{caseId}`, Terminal) as a read-only share. Every write answers 403 `SHARE_READ_ONLY`. AI work happens on the lawyer's workspace copy (`POST /client-requests/{id}/copy`).",
      "",
      "Socket events (on the existing connection, user room; refetch on receipt):",
      "",
      "| Event | Payload | When |",
      "| --- | --- | --- |",
      "| `client-request:new` | `{ requestId, caseAreas, ukJurisdiction, urgency, routingExpiresAt }` | Routed to you |",
      "| `client-request:taken` | `{ requestId }` | Claimed by someone else, withdrawn or expired: drop it from the inbox |",
      "| `client-request:updated` | `{ requestId, status, updatedAt }` | A request you hold changed |",
      "| `client-request:claim-expiring` | `{ requestId, claimExpiresAt }` | 2h before your hold ends |",
      "| `engagement:message` | `{ requestId, message }` | The client posts in the thread |",
      "| `engagement:document-added` | `{ requestId, caseId, documentId, filename, submittedBy, submittedAt }` | The client adds a document to the case, or shares one in the thread |",
      "| `engagement:ai-budget` | `{ requestId, percentUsed, state }` | Crossed 80% or 100%, or topped up |",
      "| `shared-cases:changed` (existing) | `{ caseId, shared: false }` | Engagement closed: live access ended |",
    ].join("\n"),
  },
  {
    name: BILLING_TAG,
    description:
      "The organization's card on file (Stripe-hosted setup, so no card data reaches this API), the per-case fee and AI top-up history, and the Stripe webhook. The introduction fee and top-up packs are set per region in ilovelawyer-admin (ilovelawyer-api#598). Organization OWNER/ADMIN only, except the top-up packs list.",
  },
  {
    name: ADMIN_TAG,
    description:
      "ilovelawyer-admin (`ADMIN` accounts). Lawyer verification against the regulator's register, the practice areas lawyers pick from, the request queue, fees and refunds. Every action is audited.",
  },
];

export const clientHandoffSchemas: Schemas = {
  Money: {
    type: "object",
    description: "An amount in the currency's minor unit (pence).",
    properties: { amountMinor: { type: "integer" }, currency: { type: "string", enum: ["GBP"] } },
    required: ["amountMinor", "currency"],
    example: { amountMinor: 8000, currency: "GBP" },
  },
  CaseBrief: {
    type: "object",
    description: "What every matching lawyer sees before a claim. Generated from the case by AI. Never holds party names, document names or documents.",
    properties: {
      summary: { type: "string" },
      caseAreas: caseAreaNames("The case's areas by name, as when the brief was written"),
      ukJurisdiction: enumOf(UK_JURISDICTIONS),
      urgency: enumOf(REQUEST_URGENCIES, "URGENT: a hearing or deadline within 7 days; SOON: within 30"),
      knownDeadline: { type: "string", format: "date", nullable: true },
      clientNote: { type: "string", description: "The client's note on the request, as written" },
      generatedAt: dateTime(),
      intake: { ...ref("AnonymisedIntake"), nullable: true, description: "The client's intake (ADR 0018), redacted the same way summary/clientNote are. Null until the intake has run once." },
    },
    example: {
      summary: "Employee dismissed after 3 years' service without a disciplinary process; wants to know whether to bring an unfair dismissal claim.",
      caseAreas: ["Employment"],
      ukJurisdiction: "England and Wales",
      urgency: "SOON",
      knownDeadline: "2026-12-01",
      clientNote: "I'd prefer a fixed fee if possible.",
      generatedAt: "2026-10-20T09:00:00.000Z",
      intake: null,
    },
  },
  IntakeCompleteness: {
    type: "object",
    nullable: true,
    description: "Lawyer Readiness (Jev), when that check is enabled; null when it's off or hasn't run.",
    properties: {
      ready: { type: "boolean" },
      criteria: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, met: { type: "boolean" } } } },
    },
  },
  AnonymisedIntake: {
    type: "object",
    description: "The client's intake with every name, document name and source id stripped (ADR 0018) — what a lawyer sees before claiming, folded into CaseBrief.intake.",
    properties: {
      timeline: { type: "array", items: { type: "object", properties: { id: { type: "string" }, date: { type: "string", format: "date", nullable: true }, datePrecision: enumOf(["DAY", "MONTH", "YEAR", "UNKNOWN"]), text: { type: "string" } } } },
      goals: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      concerns: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      questionsForLawyer: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      deadlines: { type: "array", items: { type: "object", properties: { id: { type: "string" }, date: { type: "string", format: "date", nullable: true }, text: { type: "string" } } } },
      missing: { type: "array", items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" } } } },
      completeness: ref("IntakeCompleteness"),
    },
  },
  CaseIntake: {
    type: "object",
    description: "The client's intake, in full (ADR 0018): real names and document names, each item carrying its source. Only through GET /client-requests/{id}/intake-package, once engaged.",
    properties: {
      generatedAt: dateTime(undefined, true),
      status: enumOf(["EMPTY", "RUNNING", "READY", "FAILED", "STALE"]),
      summary: { type: "string", nullable: true },
      people: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" } } } },
      timeline: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, date: { type: "string", format: "date", nullable: true } } } },
      facts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      goals: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      concerns: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      questionsForLawyer: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
      deadlines: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, date: { type: "string", format: "date", nullable: true } } } },
      missing: { type: "array", items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" } } } },
      conflicts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, description: { type: "string" } } } },
      completeness: ref("IntakeCompleteness"),
    },
  },
  IntakePackageForLawyer: {
    type: "object",
    description: "The engaged lawyer's full read of the client's intake (ADR 0018): the case's own fields, the client's transcript and its documents, alongside the live CaseIntake.",
    properties: {
      requestId: { type: "string" },
      caseId: { type: "string" },
      caseDetails: {
        type: "object",
        properties: {
          title: { type: "string" },
          caseAreas: caseAreaNames(),
          ukJurisdiction: enumOf(UK_JURISDICTIONS),
          town: { type: "string", nullable: true },
          side: { type: "string", enum: ["CLAIMANT", "RESPONDENT"], nullable: true },
          otherParties: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } } } },
          clientNote: { type: "string" },
        },
      },
      intake: ref("CaseIntake"),
      transcript: { type: "array", items: { type: "object", properties: { id: { type: "string" }, role: { type: "string", enum: ["CLIENT", "AI"] }, text: { type: "string" }, createdAt: dateTime() } } },
      documents: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string", enum: ["PENDING", "READY", "FAILED"] }, category: { type: "string", nullable: true }, url: { type: "string", nullable: true } } } },
    },
  },
  Quote: {
    type: "object",
    properties: {
      type: enumOf(QUOTE_TYPES),
      amount: money("The lawyer's fee to the client, paid to the lawyer directly. The platform takes no cut"),
      message: { type: "string", maxLength: 2000 },
      sentAt: dateTime(),
    },
    example: { type: "FIRST_CONSULTATION", amount: { amountMinor: 15000, currency: "GBP" }, message: "Happy to review this with you on a call this week.", sentAt: "2026-10-20T12:00:00.000Z" },
  },
  LawyerPublicProfile: {
    type: "object",
    description: "What the client sees of the claiming lawyer, from QUOTED onwards.",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      avatarUrl: { type: "string", nullable: true },
      firmName: { type: "string", nullable: true, description: "Null for a solo practitioner's personal workspace" },
      regulator: enumOf(LAWYER_REGULATORS),
      registrationNumber: { type: "string", description: "SRA number, or the Law Society of Scotland / Northern Ireland number" },
      practiceAreas: { type: "array", items: { type: "string" }, description: "Names from the lawyer's site's list, which admins edit", example: ["Employment Law"] },
      qualifiedJurisdictions: { type: "array", items: enumOf(UK_JURISDICTIONS) },
      languages: { type: "array", items: { type: "string" }, example: ["English"] },
      bio: { type: "string" },
      firstConsultationFee: { ...money(), nullable: true },
      verifiedAt: dateTime(),
    },
  },
  UkRegistration: {
    type: "object",
    description: "The UK part of a Lawyer Application: what the admin checks against the regulator's register.",
    properties: {
      country: { type: "string", enum: ["UK"] },
      regulator: { ...enumOf(LAWYER_REGULATORS), nullable: true },
      registrationNumber: { type: "string", nullable: true, maxLength: 40 },
      qualifiedJurisdictions: { type: "array", items: enumOf(UK_JURISDICTIONS) },
    },
  },
  PhRegistration: {
    type: "object",
    description: "The PH part of a Lawyer Application. Only rollNumber and ibpChapter are required to submit (the PH rules aren't final).",
    properties: {
      country: { type: "string", enum: ["PH"] },
      rollNumber: { type: "string", nullable: true, maxLength: 40, description: "Roll of Attorneys number" },
      ibpChapter: { type: "string", nullable: true, maxLength: 80 },
      ibpMembershipNumber: { type: "string", nullable: true, maxLength: 40 },
      mcleNumber: { type: "string", nullable: true, maxLength: 40 },
      mclePeriod: { type: "string", nullable: true, maxLength: 20, description: "As on the certificate, e.g. VII" },
    },
  },
  ClientRequestProfile: {
    type: "object",
    description:
      "A lawyer's Lawyer Application, UK or PH (the lawyer's site). On UK it also holds the settings for receiving client requests; on PH approval only shows a badge for now.",
    properties: {
      country: enumOf(LAWYER_COUNTRIES),
      registration: { oneOf: [ref("UkRegistration"), ref("PhRegistration")], discriminator: { propertyName: "country" } },
      practiceAreas: { type: "array", items: ref("LawyerPracticeArea"), description: "From the site's list (GET /practice-areas), in its order" },
      bio: { type: "string", maxLength: 1500 },
      languages: { type: "array", items: { type: "string" } },
      firstConsultationFee: {
        type: "object",
        nullable: true,
        description: "Minor units: pence on UK, centavos on PH.",
        properties: { amountMinor: { type: "integer" }, currency: { type: "string", enum: ["GBP", "PHP"] } },
      },
      acceptingRequests: { type: "boolean", description: "The lawyer's own switch (UK only). The organization can also turn it off per member" },
      enabledByOrganization: { type: "boolean", readOnly: true },
      pausedUntil: dateTime("Skipped by routing until then", true),
      capacityLimit: { type: "integer", nullable: true, minimum: 1, description: "Most engagements open at once; null for no limit" },
      openEngagements: { type: "integer", readOnly: true },
      verification: {
        type: "object",
        readOnly: true,
        properties: {
          status: enumOf(LAWYER_VERIFICATION_STATUSES),
          note: { type: "string", nullable: true, description: "The admin's note on a rejection" },
          verifiedAt: dateTime(undefined, true),
        },
      },
      missing: { type: "array", readOnly: true, items: { type: "string" }, description: "Fields still needed before verification can start" },
    },
  },
  PracticeAreaOption: {
    type: "object",
    description: "One practice area a lawyer can pick on their site.",
    properties: { id: { type: "string", format: "uuid" }, name: { type: "string", example: "Employment Law" } },
  },
  LawyerPracticeArea: {
    type: "object",
    description: "A practice area on a lawyer's application.",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string", example: "Employment Law" },
      isActive: { type: "boolean", description: "False once an admin switches the area off: the lawyer keeps it until they drop it, but it no longer routes requests" },
    },
  },
  AdminCaseArea: {
    type: "object",
    description: "A kind of problem a client's case can be about (the client app's \"Type of issue\").",
    properties: {
      id: { type: "string", format: "uuid" },
      country: enumOf(LAWYER_COUNTRIES),
      code: { type: "string", example: "EMPLOYMENT", description: "What cases and practice areas hold. Fixed once made" },
      name: { type: "string", maxLength: 60 },
      description: { type: "string", maxLength: 500, description: "What Jev is told the area covers when it decides a case's areas" },
      isActive: { type: "boolean", description: "Off: hidden from the client's picker and from Jev, kept on cases that have it. OTHER is always on" },
      sortOrder: { type: "integer" },
      caseCount: { type: "integer", description: "Cases that have it" },
      practiceAreaCount: { type: "integer", description: "Practice areas that map to it. Deleting needs both counts at 0" },
      createdAt: dateTime(),
      updatedAt: dateTime(),
    },
  },
  AdminPracticeArea: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      country: enumOf(LAWYER_COUNTRIES),
      name: { type: "string", maxLength: 100 },
      caseArea: { type: "string", nullable: true, example: "EMPLOYMENT", description: "The code of one of the site's client case areas (GET /admin/case-areas) a lawyer with this area is routed; null never routes. Matching is UK only for now" },
      isActive: { type: "boolean", description: "Off: hidden from the picker and from matching, kept where held" },
      sortOrder: { type: "integer" },
      lawyerCount: { type: "integer", description: "Lawyers holding it. Deleting needs 0" },
      createdAt: dateTime(),
      updatedAt: dateTime(),
    },
  },
  ClaimSummary: {
    type: "object",
    properties: {
      byMe: { type: "boolean" },
      lawyer: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, description: "Only for the holder and the organization's OWNER/ADMIN" },
      claimedAt: dateTime(),
      claimExpiresAt: dateTime("24h after the claim. Cleared once the client confirms"),
    },
  },
  ChargeSummary: {
    type: "object",
    properties: { id: { type: "string" }, status: enumOf(CHARGE_STATUSES), amount: money(), failureReason: { type: "string", nullable: true } },
  },
  ClientRequestForLawyer: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: enumOf(CLIENT_REQUEST_STATUSES),
      brief: ref("CaseBrief"),
      routedAt: dateTime(undefined, true),
      routingExpiresAt: dateTime("48h after routing, while unclaimed", true),
      claim: { ...ref("ClaimSummary"), nullable: true },
      quote: { ...ref("Quote"), nullable: true },
      perCaseFee: { ...money("What confirming will charge the organization now: the region's introduction fee, set in admin"), readOnly: true },
      charge: { ...ref("ChargeSummary"), nullable: true, description: "The per-case fee, from CONFIRMED" },
      engagement: {
        type: "object",
        nullable: true,
        properties: {
          caseId: { type: "string", description: "The client's case, open read-only through /my-cases/{caseId}" },
          workspaceId: { type: "string", description: "The client's workspace the case lives in: send it as X-Organization-Id to open the case" },
          clientName: { type: "string" },
          engagedAt: dateTime(),
          closedAt: dateTime(undefined, true),
          closedBy: { type: "string", enum: ["LAWYER", "CLIENT"], nullable: true },
          copyCaseId: { type: "string", nullable: true, description: "The lawyer's workspace copy, once made" },
        },
      },
      assignedTo: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" } } },
    },
  },
  LawyerRequestForClient: {
    type: "object",
    properties: {
      id: { type: "string" },
      caseId: { type: "string" },
      status: enumOf(CLIENT_REQUEST_STATUSES),
      note: { type: "string" },
      consentVersion: { type: "string" },
      consentAcceptedAt: dateTime(),
      createdAt: dateTime(),
      lawyer: { ...ref("LawyerPublicProfile"), nullable: true, description: "From QUOTED (#512). firmName is null for a solo practitioner's personal workspace" },
      quote: { ...ref("Quote"), nullable: true },
      referralDisclosure: { type: "string", nullable: true, description: "Shown on the quote screen; the client acknowledges it to confirm" },
      engagedAt: dateTime(undefined, true),
      closedAt: dateTime(undefined, true),
      closedBy: { type: "string", enum: ["LAWYER", "CLIENT"], nullable: true },
      feedback: { ...ref("EngagementFeedback"), nullable: true },
    },
  },
  ConflictParties: {
    type: "object",
    description: "The case's parties, for the claiming lawyer's conflict check. Every read is audited.",
    properties: {
      parties: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, role: { type: "string", example: "Opposing party" } } },
      },
    },
  },
  LawyerRequestConsent: {
    type: "object",
    description: "The current consent wording. The client accepts this version when creating a request. Wording pending solicitor review (FORHU/ilovelawyer-app#846).",
    properties: {
      version: { type: "string", example: "2026-10-20" },
      consentText: { type: "string", description: "Sharing the anonymised brief; party names to the claiming lawyer; read access on confirm; the lawyer may keep a copy" },
      referralDisclosure: { type: "string", description: "The lawyer pays the platform for the introduction (SRA)" },
    },
  },
  LawyerRequestEligibility: {
    type: "object",
    properties: {
      eligible: { type: "boolean" },
      reason: {
        type: "string",
        nullable: true,
        enum: ["NOT_UK_CASE", "PERSONAL_INJURY_EXCLUDED", "REQUEST_ALREADY_OPEN", null],
        description: "NOT_UK_CASE shows \"Not available yet\"",
      },
      openRequestId: { type: "string", nullable: true, description: "Set with REQUEST_ALREADY_OPEN" },
    },
  },
  EngagementMessage: {
    type: "object",
    description: "Encrypted at rest like other messages.",
    properties: {
      id: { type: "string" },
      requestId: { type: "string" },
      author: {
        type: "object",
        properties: { id: { type: "string", nullable: true }, name: { type: "string" }, side: { type: "string", enum: ["CLIENT", "LAWYER", "SYSTEM"] } },
      },
      body: { type: "string" },
      document: {
        type: "object",
        nullable: true,
        properties: {
          id: { type: "string" },
          filename: { type: "string" },
          submittedBy: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
          submittedAt: dateTime(),
        },
      },
      createdAt: dateTime(),
    },
  },
  EngagementFeedback: {
    type: "object",
    properties: { rating: { type: "integer", minimum: 1, maximum: 5 }, comment: { type: "string", maxLength: 2000 }, createdAt: dateTime() },
  },
  AiBudget: {
    type: "object",
    description: "The engagement's own AI budget, separate from any allowance in the lawyer's plan. Counts AI use on the lawyer's workspace copy.",
    properties: {
      included: money("Comes with the per-case fee"),
      toppedUp: money(),
      used: money(),
      remaining: money(),
      percentUsed: { type: "number" },
      state: enumOf(AI_BUDGET_STATES, "WARNING from 80%; EXHAUSTED at 100%, when AI actions answer 403 ENGAGEMENT_AI_BUDGET_SPENT"),
    },
  },
  TopUpPack: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, price: money(), credit: money("AI credit added to the engagement") },
    example: { id: "standard", name: "Standard", price: { amountMinor: 4000, currency: "GBP" }, credit: { amountMinor: 2400, currency: "GBP" } },
  },
  PaymentCard: {
    type: "object",
    properties: {
      brand: { type: "string", example: "visa" },
      last4: { type: "string", example: "4242" },
      expMonth: { type: "integer" },
      expYear: { type: "integer" },
      provider: { type: "string", enum: ["STRIPE", "DUMMY"], description: "DUMMY: a test card (LAWYER_PAYMENT_PROVIDER=dummy), never charged for real" },
      updatedAt: dateTime(),
    },
  },
  Charge: {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: enumOf(CHARGE_KINDS),
      status: enumOf(CHARGE_STATUSES),
      amount: money(),
      credit: { ...money("AI_TOP_UP only: the AI credit it adds to the engagement's budget"), nullable: true },
      refunded: money(),
      requestId: { type: "string" },
      lawyer: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" } } },
      failureReason: { type: "string", nullable: true },
      receiptUrl: { type: "string", nullable: true, description: "Stripe's receipt for a paid charge; null for a DUMMY test card or before it's paid" },
      provider: { type: "string", enum: ["STRIPE", "DUMMY"], nullable: true, description: "The card's provider; null before the first attempt" },
      createdAt: dateTime(),
    },
  },
  OrganizationMemberRequestSetting: {
    type: "object",
    properties: {
      userId: { type: "string" },
      name: { type: "string" },
      role: { type: "string", enum: ["OWNER", "ADMIN", "MANAGER", "MEMBER"] },
      enabled: { type: "boolean", description: "The organization's switch for this member" },
      acceptingRequests: { type: "boolean", description: "The member's own switch" },
      verificationStatus: enumOf(LAWYER_VERIFICATION_STATUSES),
      openEngagements: { type: "integer" },
    },
  },
  RegisterCheck: {
    type: "object",
    description: "The regulator's register entry for the lawyer's registration number, compared with their profile.",
    properties: {
      register: enumOf(LAWYER_REGULATORS),
      checkedAt: dateTime(),
      found: { type: "boolean" },
      registeredName: { type: "string", nullable: true },
      practising: { type: "boolean", nullable: true },
      admittedOn: { type: "string", format: "date", nullable: true },
      mismatches: { type: "array", items: { type: "string", enum: ["NOT_FOUND", "NAME", "NOT_PRACTISING", "JURISDICTION"] } },
    },
  },
  AdminLawyerVerification: {
    type: "object",
    properties: {
      userId: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      organizationName: { type: "string", nullable: true, description: "Null for a solo practitioner" },
      firm: {
        type: "object",
        nullable: true,
        description: "The lawyer's organization's details; null for a solo practitioner. Not reviewed separately",
        properties: {
          name: { type: "string" },
          regulator: { ...enumOf(LAWYER_REGULATORS), nullable: true },
          registrationNumber: { type: "string", nullable: true },
          phone: { type: "string", nullable: true },
          address: {
            type: "object",
            properties: { line1: { type: "string", nullable: true }, line2: { type: "string", nullable: true }, city: { type: "string", nullable: true }, postcode: { type: "string", nullable: true } },
          },
        },
      },
      profile: ref("ClientRequestProfile"),
      registerCheck: { ...ref("RegisterCheck"), nullable: true, description: "Null when the register couldn't be reached; the admin checks by hand" },
      submittedAt: dateTime("When the profile last joined the queue; null while UNSUBMITTED", true),
    },
  },
  AdminClientRequest: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: enumOf(CLIENT_REQUEST_STATUSES),
      createdAt: dateTime(),
      ageHours: { type: "number" },
      unclaimedOver48h: { type: "boolean" },
      caseAreas: caseAreaNames(),
      ukJurisdiction: enumOf(UK_JURISDICTIONS),
      matchedLawyers: { type: "integer" },
      claims: {
        type: "array",
        items: { type: "object", properties: { lawyerId: { type: "string" }, lawyerName: { type: "string" }, claimedAt: dateTime(), outcome: { ...enumOf(CLAIM_OUTCOMES), nullable: true } } },
      },
      organizationName: { type: "string", nullable: true },
      charges: { type: "array", items: ref("Charge") },
    },
  },
  FeesSummaryRow: {
    type: "object",
    properties: {
      id: { type: "string", description: "Lawyer or organization id, per groupBy" },
      name: { type: "string" },
      engagements: { type: "integer" },
      perCaseFees: money(),
      topUps: money(),
      refunds: money(),
    },
  },
};

const requestId = [idParam()];

export const clientHandoffPaths: Paths = {
  // ── Client app ──────────────────────────────────────────────────────────
  "/client/lawyer-requests/consent": {
    get: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#507", built: true,
      summary: "The current consent and referral-fee disclosure text",
      responses: { 200: ok("Consent text", ref("LawyerRequestConsent")) },
    }),
  },
  "/client/lawyer-requests/eligibility": {
    get: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#507", built: true,
      summary: "Whether to show Get a lawyer on a case, and why not",
      parameters: [{ name: "caseId", in: "query", required: true, schema: { type: "string", format: "uuid" } }],
      responses: { 200: ok("Eligibility", ref("LawyerRequestEligibility")), 404: err("No such case of yours") },
    }),
  },
  "/client/lawyer-requests": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#507", built: true,
      summary: "Ask for a lawyer on one of your UK cases",
      description: "Stores the consent with its version and time, generates the anonymised brief (#508) and routes it (#509).",
      body: {
        type: "object",
        required: ["caseId", "consentVersion", "consentAccepted"],
        properties: {
          caseId: { type: "string", format: "uuid" },
          note: { type: "string", maxLength: 1000 },
          consentVersion: { type: "string", description: "The version from GET /lawyer-requests/consent the client agreed to" },
          consentAccepted: { type: "boolean", enum: [true] },
        },
      },
      responses: {
        201: ok("Request created (REQUESTED)", ref("LawyerRequestForClient")),
        400: err("CONSENT_REQUIRED, or a validation error"),
        404: err("No such case of yours"),
        409: err("REQUEST_ALREADY_OPEN or CONSENT_VERSION_STALE"),
        422: err("NOT_UK_CASE or PERSONAL_INJURY_EXCLUDED"),
      },
    }),
    get: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#507", built: true,
      summary: "Your lawyer requests, newest first",
      parameters: [{ name: "caseId", in: "query", schema: { type: "string", format: "uuid" } }, ...pageParams],
      responses: { 200: ok("Requests", page("LawyerRequestForClient")) },
    }),
  },
  "/client/lawyer-requests/{id}": {
    get: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#507", built: true,
      summary: "One request: status, and from QUOTED the lawyer's profile and quote",
      parameters: requestId,
      responses: { 200: ok("Request", ref("LawyerRequestForClient")), 404: NOT_FOUND },
    }),
  },
  "/client/lawyer-requests/{id}/withdraw": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#507", built: true,
      summary: "Withdraw before engagement",
      description: "Allowed up to QUOTED. Any claim ends WITHDRAWN and matching lawyers get client-request:taken.",
      parameters: requestId,
      responses: { 200: ok("Withdrawn", ref("LawyerRequestForClient")), 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client/lawyer-requests/{id}/confirm": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#513", built: true,
      summary: "Confirm the quoted lawyer",
      description:
        "Only from QUOTED, once: confirming twice charges once. Moves to CONFIRMED and charges the lawyer's organization the per-case fee straight away, off-session on its card on file (Stripe, or a DUMMY test card that takes no money). Paid: ENGAGED (engagedAt set); the lawyer's read access to the case comes with #514. Declined, or no card: it stays CONFIRMED, the lawyer and the organization's OWNER/ADMINs are notified to update the card, and the lawyer retries (POST /client-requests/{id}/charge/retry). A bank that settles later leaves it CONFIRMED until Stripe's webhook.",
      parameters: requestId,
      body: { type: "object", required: ["disclosureAcknowledged"], properties: { disclosureAcknowledged: { type: "boolean", enum: [true] } } },
      responses: { 200: ok("Confirmed or engaged", ref("LawyerRequestForClient")), 400: err("DISCLOSURE_NOT_ACKNOWLEDGED"), 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client/lawyer-requests/{id}/decline": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#513", built: true,
      summary: "Decline the quote",
      description: "Only from QUOTED. Nothing is charged. The claim ends DECLINED (the reason stays on it) and the request goes back to ROUTED for 48h, without that lawyer, who is notified.",
      parameters: requestId,
      body: { type: "object", properties: { reason: { type: "string", maxLength: 500 } } },
      responses: { 200: ok("Back to ROUTED", ref("LawyerRequestForClient")), 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client/lawyer-requests/{id}/messages": {
    get: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#517", built: true,
      summary: "The engagement thread, oldest first",
      description: "Open from ENGAGED, and still readable once CLOSED. 409 before a lawyer is engaged.",
      parameters: [...requestId, ...threadParams],
      responses: { 200: ok("Messages", threadPage), 404: NOT_FOUND, 409: BAD_STATUS },
    }),
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#517", built: true,
      summary: "Post in the thread, optionally sharing a document from the case",
      description:
        "Text, a document already on the case (documentId), or both. Sharing a document also sends engagement:document-added to the lawyer. The lawyer gets engagement:message. Encrypted at rest. Posting marks the thread read for you.",
      parameters: requestId,
      body: { type: "object", properties: { body: { type: "string", maxLength: 5000 }, documentId: { type: "string", format: "uuid" } } },
      responses: {
        201: ok("Posted", ref("EngagementMessage")),
        400: err("Neither text nor a document"),
        404: err("Not your request, or the document isn't on the case"),
        409: err("ENGAGEMENT_CLOSED (read-only after close) or INVALID_REQUEST_STATUS"),
      },
    }),
  },
  "/client/lawyer-requests/{id}/messages/read": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#517", built: true,
      summary: "Mark the thread read",
      description: "The lawyer's messages up to now stop counting as unread.",
      parameters: requestId,
      responses: { 204: { description: "Marked read" }, 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client/lawyer-requests/{id}/end": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#519",
      summary: "End the engagement (the client's side of close)",
      description:
        "Allowed while ENGAGED. Same effect as the lawyer closing it: CLOSED with closedBy CLIENT, the lawyer's read-only access is removed at once, and the thread becomes read-only. The lawyer keeps any workspace copy they made (UK file-retention rules). The lawyer is notified.",
      parameters: requestId,
      body: { type: "object", properties: { reason: { type: "string", maxLength: 1000, description: "Shown to the lawyer" } } },
      responses: { 200: ok("Ended", ref("LawyerRequestForClient")), 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client/lawyer-requests/{id}/feedback": {
    post: op({
      tag: CLIENT_TAG,
      issue: "ilovelawyer-api#519",
      summary: "Rate the lawyer after the engagement closes",
      description: "Once per request. Allowed only when CLOSED.",
      parameters: requestId,
      body: { type: "object", required: ["rating"], properties: { rating: { type: "integer", minimum: 1, maximum: 5 }, comment: { type: "string", maxLength: 2000 } } },
      responses: { 201: ok("Stored", ref("EngagementFeedback")), 404: NOT_FOUND, 409: err("Already given, or INVALID_REQUEST_STATUS") },
    }),
  },

  // ── Lawyer app: profile ─────────────────────────────────────────────────
  "/practice-areas": {
    get: op({
      tag: LAWYER_TAG,
      issue: "practice areas",
      built: true,
      summary: "The practice areas a lawyer can pick on a site",
      description: "Switched-on areas only, in the order admins set. Pass the application's country (ClientRequestProfile.country).",
      parameters: [{ name: "country", in: "query", required: true, schema: enumOf(LAWYER_COUNTRIES) }],
      responses: { 200: ok("Areas", { type: "array", items: ref("PracticeAreaOption") }), 400: err("No country") },
    }),
  },
  "/users/me/client-request-profile": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#504", built: true,
      summary: "Your Lawyer Application",
      responses: { 200: ok("Profile", ref("ClientRequestProfile")), 403: err("NOT_A_LAWYER or NOT_SUPPORTED_TENANT") },
    }),
    patch: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#504", built: true,
      summary: "Update your Lawyer Application",
      description:
        "registration must be your own site's (400 WRONG_COUNTRY otherwise). Changing what was checked sends a VERIFIED or REJECTED application back to PENDING: UK regulator, number or jurisdictions; PH Roll number or IBP chapter. Turning on acceptingRequests answers 403 NOT_UK_TENANT on PH, and before verification 422 PROFILE_INCOMPLETE or 403 LAWYER_NOT_VERIFIED.",
      body: {
        type: "object",
        properties: {
          registration: { oneOf: [ref("UkRegistration"), ref("PhRegistration")], discriminator: { propertyName: "country" } },
          practiceAreaIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Replaces your areas. Ids from GET /practice-areas for your site (400 UNKNOWN_PRACTICE_AREA otherwise). An area an admin switched off can be kept but not added (400 PRACTICE_AREA_INACTIVE). Changing areas never sends the application back for verification",
          },
          bio: { type: "string", maxLength: 1500 },
          languages: { type: "array", items: { type: "string" } },
          firstConsultationFee: {
            type: "object",
            nullable: true,
            properties: { amountMinor: { type: "integer" }, currency: { type: "string", enum: ["GBP", "PHP"], description: "Your site's" } },
          },
          acceptingRequests: { type: "boolean" },
          pausedUntil: dateTime(undefined, true),
          capacityLimit: { type: "integer", minimum: 1, nullable: true },
        },
      },
      responses: { 200: ok("Updated", ref("ClientRequestProfile")), 400: err("Validation error"), 403: LAWYER_ONLY, 422: err("PROFILE_INCOMPLETE (details.missing)") },
    }),
  },

  // ── Lawyer app: inbox, claim, quote, engagement ─────────────────────────
  "/client-requests": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#511", built: true,
      summary: "The Client Requests inbox",
      description: "inbox: routed to you, unclaimed, not passed. mine: ones you hold or are engaged on. history: ones you held that ended (released, lapsed, declined, closed).",
      parameters: [{ name: "view", in: "query", schema: { type: "string", enum: ["inbox", "mine", "history"], default: "inbox" } }, ...pageParams],
      responses: { 200: ok("Requests", page("ClientRequestForLawyer")), 403: LAWYER_ONLY },
    }),
  },
  "/client-requests/{id}": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#511", built: true,
      summary: "One request: the brief, and your claim, quote and engagement",
      parameters: requestId,
      responses: { 200: ok("Request", ref("ClientRequestForLawyer")), 403: LAWYER_ONLY, 404: NOT_FOUND },
    }),
  },
  "/client-requests/{id}/claim": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#511", built: true,
      summary: "Accept: hold the request for 24h",
      description: "Only one lawyer can win. The others get client-request:taken. Needs no card: sending the quote does (FORHU/ilovelawyer-app#933). Nothing is charged until the client confirms.",
      parameters: requestId,
      responses: {
        200: ok("Claimed (CLAIMED)", ref("ClientRequestForLawyer")),
        403: LAWYER_ONLY,
        404: NOT_FOUND,
        409: err("REQUEST_ALREADY_CLAIMED or INVALID_REQUEST_STATUS"),
      },
    }),
  },
  "/client-requests/{id}/pass": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#511", built: true,
      summary: "Pass: hide the request from you",
      parameters: requestId,
      responses: { 204: ok("Hidden"), 403: LAWYER_ONLY, 404: NOT_FOUND },
    }),
  },
  "/client-requests/{id}/parties": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#512", built: true,
      summary: "Party names for the conflict check",
      description:
        "The client (role \"Client\") first, then the case's other parties as the client entered them. Only for the lawyer holding the claim, while CLAIMED (inside the 24h hold) or QUOTED; 404 for anyone who never held it. Every read is audited (client_request.parties_viewed).",
      parameters: requestId,
      responses: { 200: ok("Parties", ref("ConflictParties")), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: err("CLAIM_EXPIRED or INVALID_REQUEST_STATUS") },
    }),
  },
  "/client-requests/{id}/intake-package": {
    get: op({
      tag: LAWYER_TAG,
      issue: "docs/adr/0018-client-app-is-intake-not-advice.md", built: true,
      summary: "The client's full intake: the case, the transcript, the documents and the live CaseIntake",
      description:
        "Only once ENGAGED, and only for the lawyer that engagement is for (404 otherwise, same as copy/close). Read-only; no redaction — the lawyer already has full case access through the engagement grant. Every read is audited (client_request.intake_package_viewed).",
      parameters: requestId,
      responses: { 200: ok("Intake package", ref("IntakePackageForLawyer")), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: err("INVALID_REQUEST_STATUS: this request isn't engaged") },
    }),
  },
  "/client-requests/{id}/release": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#512", built: true,
      summary: "Give the request back (conflict found, no capacity, out of scope)",
      description:
        "From CLAIMED, or QUOTED before the client answers. The claim ends RELEASED and the request is routed again for 48h without you, and announced again (#510). Audited (client_request.released) with the reason; the note stays on the claim only, since it may name the conflict.",
      parameters: requestId,
      body: { type: "object", required: ["reason"], properties: { reason: enumOf(RELEASE_REASONS), note: { type: "string", maxLength: 500 } } },
      responses: { 200: ok("Back to ROUTED", ref("ClientRequestForLawyer")), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client-requests/{id}/quote": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#512", built: true,
      summary: "Send your quote to the client",
      description:
        "Allowed while CLAIMED and inside the 24h hold (409 CLAIM_EXPIRED after it). Moves to QUOTED, once. GBP only. A FIXED_FEE needs an amount above 0; a FIRST_CONSULTATION may be free. Once quoted, the hold no longer lapses: the request waits for the client to confirm or decline (#513). The client then sees the quote and the lawyer's public profile on GET /client/lawyer-requests/{id}. Needs a card on file for the per-case fee confirming will charge (the firm's, or a solo lawyer's own): 402 CARD_REQUIRED otherwise (FORHU/ilovelawyer-app#933).",
      parameters: requestId,
      body: {
        type: "object",
        required: ["type", "amount", "message"],
        properties: { type: enumOf(QUOTE_TYPES), amount: money(), message: { type: "string", maxLength: 2000 } },
      },
      responses: { 200: ok("Quoted (QUOTED)", ref("ClientRequestForLawyer")), 400: err("Validation error"), 402: err("CARD_REQUIRED: no card on file"), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: err("CLAIM_EXPIRED or INVALID_REQUEST_STATUS") },
    }),
  },
  "/client-requests/{id}/charge/retry": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#513", built: true,
      summary: "Retry the per-case fee after updating the card",
      description:
        "Only the lawyer holding the request, while CONFIRMED with a FAILED charge (409 otherwise, including while a payment is still processing). Each retry is a new payment on the current card; two at once can't both run. An attempt that got no answer from Stripe is retried with the same idempotency key, so it can't charge twice. If it still hasn't gone through 48h after the client confirmed, the request goes back to other lawyers (the claim ends LAPSED) and the lawyer is told (#933).",
      parameters: requestId,
      responses: { 200: ok("Engaged, or still failed", ref("ClientRequestForLawyer")), 402: err("CHARGE_FAILED"), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client-requests/{id}/copy": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#514",
      summary: "Copy the client's case to your workspace",
      description:
        "Queued through CaseCopySvc and shown in the portfolio like other copies. The copy is a snapshot. It keeps its source (copiedFromCaseId) and this request, so AI use on it counts against the engagement's budget. It stays yours after close.",
      parameters: requestId,
      responses: {
        202: ok("Copy queued", { type: "object", properties: { caseCopyId: { type: "string" }, status: { type: "string", enum: ["PENDING", "DONE", "FAILED"] } } }),
        403: LAWYER_ONLY,
        404: NOT_FOUND,
        409: BAD_STATUS,
      },
    }),
  },
  "/client-requests/{id}/ai-budget": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#515",
      summary: "The engagement's AI budget meter",
      parameters: requestId,
      responses: { 200: ok("Budget", ref("AiBudget")), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client-requests/{id}/ai-top-ups": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#516", built: true,
      summary: "Buy a top-up pack, after the lawyer approves it",
      description:
        "Never automatic: refused (400) without approved: true. Charged at once to the same card as the per-case fee (the firm's, or a solo lawyer's own). The credit is added once Stripe confirms the payment, from its direct answer or the webhook, then engagement:ai-budget is sent. A charge still PENDING (the bank is deciding) adds nothing yet. The charge, with its credit, shows in the fee history; a declined one shows as FAILED and adds nothing.",
      parameters: requestId,
      body: { type: "object", required: ["packId", "approved"], properties: { packId: { type: "string" }, approved: { type: "boolean", enum: [true] } } },
      responses: {
        202: ok("Charged (SUCCEEDED), or PENDING while the bank decides", ref("Charge")),
        400: err("Not approved, or no pack with that id"),
        402: err("CARD_REQUIRED: no card on file (nothing is charged or recorded). CHARGE_FAILED: declined"),
        403: LAWYER_ONLY,
        404: NOT_FOUND,
        409: err("INVALID_REQUEST_STATUS: not engaged, or another top-up is still being charged (chargeStatus PENDING)"),
      },
    }),
  },
  "/client-requests/{id}/messages": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#517", built: true,
      summary: "The engagement thread, oldest first",
      description: "Only the lawyer it's engaged on (404 for anyone else). Still readable once CLOSED.",
      parameters: [...requestId, ...threadParams],
      responses: { 200: ok("Messages", threadPage), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: BAD_STATUS },
    }),
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#517", built: true,
      summary: "Post in the thread",
      description:
        "The lawyer can't add documents to the client's case (read-only), so no documentId here. The client gets engagement:message. Encrypted at rest. Posting marks the thread read for you.",
      parameters: requestId,
      body: { type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 5000 } } },
      responses: { 201: ok("Posted", ref("EngagementMessage")), 400: err("No text"), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: err("ENGAGEMENT_CLOSED or INVALID_REQUEST_STATUS") },
    }),
  },
  "/client-requests/{id}/messages/read": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#517", built: true,
      summary: "Mark the thread read",
      description: "The client's messages up to now stop counting as unread (the Messages button's count).",
      parameters: requestId,
      responses: { 204: { description: "Marked read" }, 403: LAWYER_ONLY, 404: NOT_FOUND },
    }),
  },
  "/client-requests/{id}/close": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#519",
      summary: "Close the engagement",
      description: "Moves to CLOSED (closedBy LAWYER), removes the read-only grant (shared-cases:changed) and makes the thread read-only. Your workspace copy stays. The client is asked for feedback. The client can also end it from their side (POST /client/lawyer-requests/{id}/end).",
      parameters: requestId,
      body: { type: "object", properties: { note: { type: "string", maxLength: 1000, description: "Shown to the client" } } },
      responses: { 200: ok("Closed", ref("ClientRequestForLawyer")), 403: LAWYER_ONLY, 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },
  "/client-requests/{id}/reassign": {
    post: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#518",
      summary: "Organization OWNER/ADMIN: give a claimed or engaged request to another member",
      description: "The member must be eligible (verified, enabled, qualified, under capacity). On an engaged request the read-only grant moves to them. Audited.",
      parameters: requestId,
      body: { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" } } },
      responses: { 200: ok("Reassigned", ref("ClientRequestForLawyer")), 400: err("REASSIGN_TARGET_NOT_ELIGIBLE"), 403: err("Not the organization's OWNER/ADMIN"), 404: NOT_FOUND, 409: BAD_STATUS },
    }),
  },

  // ── Lawyer app: organization ────────────────────────────────────────────
  "/organizations/{id}/client-requests": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#518",
      summary: "OWNER/ADMIN: the organization's claimed and engaged requests, with their charges",
      description: "Request details and charges only. The client's case opens only for the assigned lawyer.",
      parameters: [idParam(), { name: "status", in: "query", schema: enumOf(CLIENT_REQUEST_STATUSES) }, ...pageParams],
      responses: { 200: ok("Requests", page("ClientRequestForLawyer")), 403: err("Not the organization's OWNER/ADMIN") },
    }),
  },
  "/organizations/{id}/client-requests/members": {
    get: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#518",
      summary: "OWNER/ADMIN: each member's client request switch",
      parameters: [idParam()],
      responses: { 200: ok("Members", { type: "array", items: ref("OrganizationMemberRequestSetting") }), 403: err("Not the organization's OWNER/ADMIN") },
    }),
  },
  "/organizations/{id}/members/{userId}/client-requests": {
    patch: op({
      tag: LAWYER_TAG,
      issue: "ilovelawyer-api#518",
      summary: "OWNER/ADMIN: turn client requests on or off for a member",
      description: "Off stops new routing to them. It doesn't take away requests they already hold.",
      parameters: [idParam(), idParam("userId")],
      body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
      responses: { 200: ok("Updated", ref("OrganizationMemberRequestSetting")), 403: err("Not the organization's OWNER/ADMIN"), 404: err("Not a member") },
    }),
  },

  // ── Lawyer app: billing ─────────────────────────────────────────────────
  "/organizations/{id}/billing/card": {
    get: op({
      tag: BILLING_TAG,
      issue: "ilovelawyer-api#505",
      summary: "The organization's card on file",
      description:
        "Pass setupSessionId (from returnUrl after Stripe) to have that setup applied first if it completed, so the card shows without waiting for the webhook. OWNER/ADMIN only, for reading too.",
      parameters: [idParam(), { name: "setupSessionId", in: "query", schema: { type: "string" }, description: "The session returnUrl came back with" }],
      responses: { 200: ok("The card, or null", { ...ref("PaymentCard"), nullable: true }), 403: err("Not the organization's OWNER/ADMIN") },
    }),
  },
  "/organizations/{id}/billing/card/setup-session": {
    post: op({
      tag: BILLING_TAG,
      issue: "ilovelawyer-api#505",
      summary: "Start a Stripe-hosted card setup (add or replace the card)",
      description:
        "Returns a Stripe Checkout URL in setup mode: the card is typed into Stripe's page, never sent here. Stripe sends the user back to returnUrl with ?cardSetup=done&setupSessionId=cs_... (or ?cardSetup=cancelled); the app then calls GET .../billing/card?setupSessionId=... The webhook (checkout.session.completed) saves it too, once either way. The organization's Stripe customer is made on its first setup. With LAWYER_PAYMENT_PROVIDER=dummy a test card (visa 4242) is saved at once and the url is returnUrl?cardSetup=done. Audited as org.payment_card_updated.",
      parameters: [idParam()],
      body: { type: "object", required: ["returnUrl"], properties: { returnUrl: { type: "string", description: "Must be on an allowed app origin" } } },
      responses: {
        200: ok("Setup session", { type: "object", properties: { url: { type: "string" } } }),
        400: err("RETURN_URL_NOT_ALLOWED: not on one of the app's origins (CLIENT_URL)"),
        403: err("Not the organization's OWNER/ADMIN"),
        502: err("PAYMENT_PROVIDER_ERROR: Stripe couldn't start the setup"),
      },
    }),
  },
  "/organizations/{id}/billing/fees": {
    get: op({
      tag: BILLING_TAG,
      issue: "ilovelawyer-api#513", built: true,
      summary: "Fee history: per-case fees, AI top-ups and refunds",
      parameters: [idParam(), { name: "kind", in: "query", schema: enumOf(CHARGE_KINDS) }, ...pageParams],
      responses: { 200: ok("Charges", page("Charge")), 403: err("Not the organization's OWNER/ADMIN") },
    }),
  },
  "/users/me/billing/card": {
    get: op({
      tag: BILLING_TAG,
      issue: "docs/adr/0022", built: true,
      summary: "A solo lawyer's own card on file",
      description:
        "A solo lawyer has no organization, so the per-case fee is charged to their own card. Same shape and setupSessionId handling as GET /organizations/{id}/billing/card.",
      parameters: [{ name: "setupSessionId", in: "query", schema: { type: "string" }, description: "The session returnUrl came back with" }],
      responses: { 200: ok("The card, or null", { ...ref("PaymentCard"), nullable: true }) },
    }),
  },
  "/users/me/billing/card/setup-session": {
    post: op({
      tag: BILLING_TAG,
      issue: "docs/adr/0022", built: true,
      summary: "Start a Stripe-hosted setup of a solo lawyer's own card",
      description:
        "As POST /organizations/{id}/billing/card/setup-session, for the lawyer's own card (their own Stripe customer). Audited as account.payment_card_updated.",
      body: { type: "object", required: ["returnUrl"], properties: { returnUrl: { type: "string", description: "Must be on an allowed app origin" } } },
      responses: {
        200: ok("Setup session", { type: "object", properties: { url: { type: "string" } } }),
        400: err("RETURN_URL_NOT_ALLOWED: not on one of the app's origins (CLIENT_URL)"),
        502: err("PAYMENT_PROVIDER_ERROR: Stripe couldn't start the setup"),
      },
    }),
  },
  "/users/me/billing/fees": {
    get: op({
      tag: BILLING_TAG,
      issue: "docs/adr/0022", built: true,
      summary: "A solo lawyer's own fee history",
      description: "Charges for client requests the lawyer took in their own workspace (no organization).",
      parameters: [{ name: "kind", in: "query", schema: enumOf(CHARGE_KINDS) }, ...pageParams],
      responses: { 200: ok("Charges", page("Charge")) },
    }),
  },
  "/billing/top-up-packs": {
    get: op({
      tag: BILLING_TAG,
      issue: "ilovelawyer-api#516", built: true,
      summary: "The AI top-up packs on offer",
      description: "The active packs of the caller's region, set in ilovelawyer-admin (Settings, Lawyer fees; ilovelawyer-api#598).",
      responses: { 200: ok("Packs", { type: "array", items: ref("TopUpPack") }) },
    }),
  },
  "/webhooks/stripe": {
    post: {
      ...op({
        tag: BILLING_TAG,
        issue: "ilovelawyer-api#537",
        built: true,
        summary: "Stripe webhook (Stripe only, not the apps)",
        description:
          "POST /api/webhooks/stripe. Mounted with a raw body ahead of express.json(), so the signature can be checked. Idempotent per Stripe event id (StripeWebhookEvent). Built for the client app's payments: checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed and checkout.session.expired. A law firm's card (ilovelawyer-api#505) is saved from checkout.session.completed in setup mode. The per-case fee (#513) settles from payment_intent.succeeded and payment_intent.payment_failed (metadata.purpose organization_charge), read fresh from Stripe.",
        responses: {},
      }),
      // Stripe signs the request instead of sending a session, so no 401.
      responses: { 200: ok("Processed, or already seen"), 400: err("Bad signature") },
      security: [],
    },
  },

  // ── Admin ───────────────────────────────────────────────────────────────
  "/admin/lawyer-verifications": {
    get: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#506",
      summary: "Lawyer Applications for one site, with the register check",
      parameters: [
        { name: "site", in: "query", schema: { ...enumOf(LAWYER_COUNTRIES), default: "UK" } },
        { name: "status", in: "query", schema: { ...enumOf(LAWYER_VERIFICATION_STATUSES), default: "PENDING" } },
        ...pageParams,
      ],
      responses: { 200: ok("Verifications", page("AdminLawyerVerification")), 403: err("Not an admin") },
    }),
  },
  "/admin/lawyer-verifications/{userId}/verify": {
    post: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#506",
      summary: "Approve a Lawyer Application",
      description:
        "UK: the admin confirms which jurisdictions the lawyer is qualified in (required, 400 without); they replace the lawyer's own. PH: no jurisdictions, only the optional note. The note is internal: it goes in the audit log, not to the lawyer. 409 unless PENDING. Audited.",
      parameters: [idParam("userId")],
      body: {
        type: "object",
        properties: {
          confirmedJurisdictions: { type: "array", items: enumOf(UK_JURISDICTIONS), minItems: 1, description: "UK only" },
          note: { type: "string", maxLength: 1000 },
        },
      },
      responses: { 200: ok("Verified", ref("AdminLawyerVerification")), 400: err("Invalid body"), 403: err("Not an admin"), 404: err("No such lawyer"), 409: err("Not PENDING") },
    }),
  },
  "/admin/lawyer-verifications/{userId}/reject": {
    post: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#506",
      summary: "Reject a Lawyer Application, with a note they will see",
      description:
        "UK reasons: NAME_MISMATCH, NOT_PRACTISING, WRONG_JURISDICTION, OTHER. PH reasons: NAME_MISMATCH, ROLL_NOT_FOUND, NOT_IN_GOOD_STANDING, OTHER. A reason from the other country answers 400. They drop out of routing. Requests they hold are released. Audited.",
      parameters: [idParam("userId")],
      body: {
        type: "object",
        required: ["reason"],
        properties: {
          reason: { type: "string", enum: LAWYER_REJECTION_REASONS, description: "Each but OTHER sends the lawyer a canned sentence, in the application's country's wording" },
          note: { type: "string", maxLength: 1000, description: "Required for OTHER, where it is the whole message; otherwise appended to the canned sentence" },
        },
      },
      responses: { 200: ok("Rejected", ref("AdminLawyerVerification")), 400: err("Invalid body"), 403: err("Not an admin"), 404: err("No such lawyer"), 409: err("Not PENDING") },
    }),
  },
  "/admin/practice-areas": {
    get: op({
      tag: ADMIN_TAG,
      issue: "practice areas",
      built: true,
      summary: "One site's practice areas, switched-off ones too",
      parameters: [{ name: "country", in: "query", required: true, schema: enumOf(LAWYER_COUNTRIES) }],
      responses: { 200: ok("Areas, in picker order", { type: "array", items: ref("AdminPracticeArea") }), 400: err("No country"), 403: err("Not an admin") },
    }),
    post: op({
      tag: ADMIN_TAG,
      issue: "practice areas",
      built: true,
      summary: "Add a practice area to a site's list",
      description: "Goes to the end of the list. A name already on the site, whatever its case, answers 409 PRACTICE_AREA_NAME_TAKEN. A caseArea the site doesn't have answers 400 UNKNOWN_CASE_AREA. Audited.",
      body: {
        type: "object",
        required: ["country", "name"],
        properties: { country: enumOf(LAWYER_COUNTRIES), name: { type: "string", maxLength: 100 }, caseArea: { type: "string", nullable: true, description: "One of the site's case area codes (400 UNKNOWN_CASE_AREA otherwise)" } },
      },
      responses: { 201: ok("Added", ref("AdminPracticeArea")), 400: err("Invalid body"), 403: err("Not an admin"), 409: err("PRACTICE_AREA_NAME_TAKEN") },
    }),
  },
  "/admin/practice-areas/reorder": {
    post: op({
      tag: ADMIN_TAG,
      issue: "practice areas",
      built: true,
      summary: "Reorder a site's practice areas",
      description: "`ids` is every area on the site, each once, in the new order (400 PRACTICE_AREA_ORDER_INCOMPLETE otherwise). Audited.",
      body: { type: "object", required: ["country", "ids"], properties: { country: enumOf(LAWYER_COUNTRIES), ids: { type: "array", items: { type: "string" } } } },
      responses: { 200: ok("The site's areas, reordered", { type: "array", items: ref("AdminPracticeArea") }), 400: err("Invalid body"), 403: err("Not an admin") },
    }),
  },
  "/admin/practice-areas/{id}": {
    patch: op({
      tag: ADMIN_TAG,
      issue: "practice areas",
      built: true,
      summary: "Rename, remap or switch a practice area on or off",
      description:
        "A rename shows on every lawyer holding the area at once, with no re-verification. Switching off hides the area from the picker and from matching; lawyers who hold it keep it. 409 PRACTICE_AREA_NAME_TAKEN, 400 UNKNOWN_CASE_AREA as on create. Audited.",
      parameters: [idParam()],
      body: {
        type: "object",
        minProperties: 1,
        properties: { name: { type: "string", maxLength: 100 }, caseArea: { type: "string", nullable: true, description: "One of the site's case area codes (400 UNKNOWN_CASE_AREA otherwise)" }, isActive: { type: "boolean" } },
      },
      responses: { 200: ok("Updated", ref("AdminPracticeArea")), 400: err("Invalid body"), 403: err("Not an admin"), 404: err("No such area"), 409: err("PRACTICE_AREA_NAME_TAKEN") },
    }),
    delete: op({
      tag: ADMIN_TAG,
      issue: "practice areas",
      built: true,
      summary: "Delete a practice area nobody holds",
      description: "409 PRACTICE_AREA_IN_USE when a lawyer holds it: switch it off instead. Audited.",
      parameters: [idParam()],
      responses: { 204: ok("Deleted"), 403: err("Not an admin"), 404: err("No such area"), 409: err("PRACTICE_AREA_IN_USE") },
    }),
  },
  "/admin/case-areas": {
    get: op({
      tag: ADMIN_TAG,
      issue: "case areas",
      built: true,
      summary: "One site's client case types, switched-off ones too",
      parameters: [{ name: "country", in: "query", required: true, schema: enumOf(LAWYER_COUNTRIES) }],
      responses: { 200: ok("Areas, in picker order", { type: "array", items: ref("AdminCaseArea") }), 400: err("No country"), 403: err("Not an admin") },
    }),
    post: op({
      tag: ADMIN_TAG,
      issue: "case areas",
      built: true,
      summary: "Add a client case type",
      description:
        "Goes to the end of the list. The code is upper-cased and must be capitals, digits or _ (400 CASE_AREA_CODE_INVALID), never PERSONAL_INJURY. 409 CASE_AREA_CODE_TAKEN or CASE_AREA_NAME_TAKEN (whatever its case). Audited.",
      body: {
        type: "object",
        required: ["country", "code", "name", "description"],
        properties: { country: enumOf(LAWYER_COUNTRIES), code: { type: "string", maxLength: 40 }, name: { type: "string", maxLength: 60 }, description: { type: "string", maxLength: 500 } },
      },
      responses: { 201: ok("Added", ref("AdminCaseArea")), 400: err("Invalid body"), 403: err("Not an admin"), 409: err("CASE_AREA_CODE_TAKEN or CASE_AREA_NAME_TAKEN") },
    }),
  },
  "/admin/case-areas/reorder": {
    post: op({
      tag: ADMIN_TAG,
      issue: "case areas",
      built: true,
      summary: "Reorder a site's client case types",
      description: "`ids` is every area on the site, each once, in the new order (400 CASE_AREA_ORDER_INCOMPLETE otherwise). Audited.",
      body: { type: "object", required: ["country", "ids"], properties: { country: enumOf(LAWYER_COUNTRIES), ids: { type: "array", items: { type: "string" } } } },
      responses: { 200: ok("The site's areas, reordered", { type: "array", items: ref("AdminCaseArea") }), 400: err("Invalid body"), 403: err("Not an admin") },
    }),
  },
  "/admin/case-areas/{id}": {
    patch: op({
      tag: ADMIN_TAG,
      issue: "case areas",
      built: true,
      summary: "Rename, redescribe or switch a client case type on or off",
      description: "The code never changes. Switching OTHER off answers 409 CASE_AREA_REQUIRED_OTHER. Audited.",
      parameters: [idParam()],
      body: {
        type: "object",
        minProperties: 1,
        properties: { name: { type: "string", maxLength: 60 }, description: { type: "string", maxLength: 500 }, isActive: { type: "boolean" } },
      },
      responses: { 200: ok("Updated", ref("AdminCaseArea")), 400: err("Invalid body"), 403: err("Not an admin"), 404: err("No such area"), 409: err("CASE_AREA_NAME_TAKEN or CASE_AREA_REQUIRED_OTHER") },
    }),
    delete: op({
      tag: ADMIN_TAG,
      issue: "case areas",
      built: true,
      summary: "Delete a client case type nothing uses",
      description: "409 CASE_AREA_IN_USE when a case has it or a practice area maps to it (details: cases, practiceAreas): switch it off instead. Never OTHER. Audited.",
      parameters: [idParam()],
      responses: { 204: ok("Deleted"), 403: err("Not an admin"), 404: err("No such area"), 409: err("CASE_AREA_IN_USE or CASE_AREA_REQUIRED_OTHER") },
    }),
  },
  "/admin/client-requests": {
    get: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#520", built: true,
      summary: "All client requests, filtered by status and age",
      description:
        "Newest first. unclaimedOver48h: still ROUTED with its 48h routing window over. matchedLawyers is counted for ROUTED requests (0 otherwise). Claims carry the lawyer, their firm, the outcome and the quote; release notes and decline reasons are left out.",
      parameters: [
        { name: "status", in: "query", schema: enumOf(CLIENT_REQUEST_STATUSES) },
        { name: "minAgeHours", in: "query", schema: { type: "integer" } },
        { name: "unclaimedOver48h", in: "query", schema: { type: "boolean" } },
        { name: "caseId", in: "query", schema: { type: "string" }, description: "One case's requests" },
        ...pageParams,
      ],
      responses: { 200: ok("Requests", page("AdminClientRequest")), 403: err("Not an admin") },
    }),
  },
  "/admin/client-requests/fees-summary": {
    get: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#520", built: true,
      summary: "Fees per lawyer or organization",
      description:
        "Paid charges created between from and to (both days included), most fees first. engagements counts paid per-case fees. A refunded charge still counts as paid; what was given back shows in refunds.",
      parameters: [
        { name: "groupBy", in: "query", schema: { type: "string", enum: ["lawyer", "organization"], default: "organization" } },
        { name: "from", in: "query", schema: { type: "string", format: "date" } },
        { name: "to", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: { 200: ok("Summary", { type: "array", items: ref("FeesSummaryRow") }), 403: err("Not an admin") },
    }),
  },
  "/admin/charges/{chargeId}": {
    get: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#520", built: true,
      summary: "One firm charge with its refunds",
      description: "Charge, plus organizationId, paymentIntentId, refundPending, refundable (0 when it can't be refunded) and refunds [{ id, amount, reason, status, externalId, failureReason, admin, createdAt }].",
      parameters: [idParam("chargeId")],
      responses: { 200: ok("Charge", ref("Charge")), 403: err("Not an admin"), 404: err("No such charge") },
    }),
  },
  "/admin/charges/{chargeId}/refund": {
    post: op({
      tag: ADMIN_TAG,
      issue: "ilovelawyer-api#520", built: true,
      summary: "Refund a per-case fee or top-up through Stripe",
      description:
        "Full when amount is left out, otherwise partial; more partial refunds may follow until nothing is left, and two admins at once can't give back more than was paid. Only a paid charge on a Stripe card: a DUMMY test card took no money. The charge becomes PARTIALLY_REFUNDED or REFUNDED as refunds go through; one Stripe hasn't finished stays PENDING until refund.updated. Gives back money only: the engagement carries on. Audited (admin.organization_charge.refunded) with the reason, in the firm's own audit log too, a failure included.",
      parameters: [idParam("chargeId")],
      body: { type: "object", required: ["reason"], properties: { amount: money(), reason: { type: "string", maxLength: 500 } } },
      responses: {
        200: ok("The charge, with the new refund", ref("Charge")),
        400: err("No reason, a bad amount, or REFUND_EXCEEDS_CHARGE"),
        403: err("Not an admin"),
        404: err("No such charge"),
        409: err("REFUND_NOT_SUPPORTED (test card), CHARGE_NOT_REFUNDABLE (not paid) or ALREADY_REFUNDED"),
        502: err("PAYMENT_PROVIDER_ERROR: Stripe refused; the refund is recorded FAILED and nothing is held"),
      },
    }),
  },
};
