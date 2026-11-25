import type { OAS3Definition } from "swagger-jsdoc";
import { CLIENT_PARTY_ROLES, CLIENT_STORY_CORRECTION_MAX_LENGTH, CLIENT_STORY_MAX_LENGTH, CLIENT_STORY_MIN_LENGTH } from "./constants/client-case.constants";
import { UK_JURISDICTIONS } from "./validation/case.validation";

/** The client app's routes (client.route.ts), merged into swagger.ts. Client accounts only:
 * anything else answers 403 CLIENT_ACCOUNT_ONLY. No X-Organization-Id: every call runs in the
 * client's personal workspace. */

type Paths = NonNullable<OAS3Definition["paths"]>;

const TAG = "Client App";
const security = [{ bearerAuth: [] }];
const caseId = { name: "caseId", in: "path", required: true, schema: { type: "string" } };
const json = (schema: object) => ({ "application/json": { schema } });
const err = (description: string) => ({ description, content: json({ $ref: "#/components/schemas/Error" }) });

const money = { type: "object", properties: { amountMinor: { type: "integer", description: "Cents" }, currency: { type: "string", example: "USD" } } };
const testOutcome = { type: "string", enum: ["decline"], description: "Dummy provider only: decline, to test the failure screen" };
const paymentStatus = { type: "string", enum: ["PENDING", "SUCCEEDED", "FAILED"] };
/** Null when the payment already settled (the dummy); otherwise what Stripe.js needs to show the form. */
const checkout = {
  type: "object",
  nullable: true,
  description: "Mount Stripe's embedded checkout with these (Stripe.js initEmbeddedCheckout). When it completes, poll GET /client/payments/{paymentId} until it isn't PENDING.",
  properties: {
    provider: { type: "string", enum: ["STRIPE"] },
    clientSecret: { type: "string" },
    publishableKey: { type: "string" },
  },
};

const documentId = { name: "documentId", in: "path", required: true, schema: { type: "string" } };
const messageId = { name: "messageId", in: "path", required: true, schema: { type: "string" } };

const clientDocument = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string", enum: ["PENDING", "READY", "FAILED"], description: "The raw extraction state; kept for older apps" },
    syncStatus: {
      type: "string",
      enum: ["processing", "done", "failed"],
      description: "#159: `status` relabeled for the evidence UI. No `uploading` here — that's the client's own pre-confirm state, before a Document row (and so this field) exists.",
    },
    size: { type: "integer", nullable: true, description: "Bytes; null when the upload didn't say" },
    uploadedAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time", description: "Same as uploadedAt; kept for older apps" },
  },
};

const intakeSource = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["CASE_DETAILS", "CLIENT", "DOCUMENT"] },
    messageId: { type: "string", nullable: true },
    documentId: { type: "string", nullable: true },
    documentName: { type: "string", nullable: true },
    page: { type: "integer", nullable: true },
  },
};
const intakeItem = { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, sources: { type: "array", items: intakeSource } } };
const intakePerson = { type: "object", properties: { ...intakeItem.properties, name: { type: "string" }, role: { type: "string" } } };
const intakeEvent = {
  type: "object",
  properties: { ...intakeItem.properties, date: { type: "string", nullable: true }, datePrecision: { type: "string", enum: ["DAY", "MONTH", "YEAR", "UNKNOWN"] } },
};
const intakeFormFields = {
  type: "object",
  description:
    "#157: the ticket's named field groups for the question-loop UI's fill progress, matching the ticket's own case-draft screenshot (case title is set at case creation and isn't repeated here). Not a second AI call — parties/typeOfAction/venue are the deterministic case-creation form data; witnesses/timeline/clientGoals/relationship/roleAndTerms/reasonGiven are the already-extracted people/timeline/goals/relationship/roleAndTerms/reasonGiven split out. relationship/roleAndTerms/reasonGiven are deliberately generic across practice areas, not employment-specific.",
  properties: {
    parties: { type: "array", items: intakePerson },
    witnesses: { type: "array", items: intakePerson },
    typeOfAction: { type: "array", items: { type: "string" }, description: "The case's own area names, e.g. \"Employment\" — set at case creation" },
    venue: { type: "string", nullable: true },
    timeline: { type: "array", items: intakeEvent },
    clientGoals: { type: "array", items: intakeItem },
    relationship: { type: "array", items: intakeItem, description: "The relationship the claim arises from, e.g. employee/employer, tenant/landlord" },
    roleAndTerms: { type: "array", items: intakeItem, description: "The client's role/position and the financial or contractual terms involved" },
    reasonGiven: { type: "array", items: intakeItem, description: "The reason the OTHER side gave for the disputed action, as stated — never inferred" },
    missing: {
      type: "array",
      items: { type: "string", enum: ["parties", "witnesses", "typeOfAction", "venue", "timeline", "clientGoals", "relationship", "roleAndTerms", "reasonGiven"] },
      description: "Which of the groups above is still empty",
    },
  },
};
const caseIntake = {
  type: "object",
  properties: {
    generatedAt: { type: "string", format: "date-time", nullable: true },
    status: { type: "string", enum: ["EMPTY", "RUNNING", "READY", "FAILED", "STALE"] },
    updates: { type: "object", properties: { allowed: { type: "boolean" }, leftToday: { type: "integer" } } },
    summary: { type: "string", nullable: true, description: "AI-written; always shown labelled as an AI summary, never established fact" },
    people: { type: "array", items: intakePerson },
    timeline: { type: "array", items: intakeEvent },
    facts: { type: "array", items: intakeItem },
    goals: { type: "array", items: intakeItem },
    concerns: { type: "array", items: intakeItem },
    questionsForLawyer: { type: "array", items: intakeItem },
    deadlines: { type: "array", items: { type: "object", properties: { ...intakeItem.properties, date: { type: "string", nullable: true } } } },
    missing: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" } } },
      description: "Open gaps the AI found in the conversation/documents — not sourced the way other items are",
    },
    conflicts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, description: { type: "string" }, sources: { type: "array", items: intakeSource } } } },
    storySoFar: {
      type: "array",
      maxItems: 5,
      description:
        "\"Here's your story so far\": what the client told us, said back to them in their own language. Facts first, deadlines last. `text` may mark its key detail with **bold** and has no other markup; render only that, never as HTML. A DEADLINE is a date the client or a document stated, never one worked out.",
      items: {
        type: "object",
        properties: { id: { type: "string" }, kind: { type: "string", enum: ["FACT", "DEADLINE"] }, text: { type: "string" }, sources: { type: "array", items: intakeSource } },
      },
    },
    completeness: {
      type: "object",
      nullable: true,
      properties: {
        ready: { type: "boolean" },
        criteria: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, met: { type: "boolean" } } } },
      },
    },
    formFields: intakeFormFields,
  },
};

const clientCase = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    areas: {
      type: "array",
      items: { type: "object", properties: { code: { type: "string", example: "EMPLOYMENT" }, name: { type: "string", example: "Employment" } } },
      description: "One or more, in the list's order (GET /client/case-areas). A switched-off one the case still has is among them",
    },
    area: { type: "string", deprecated: true, description: "The first area's code, for apps that predate several per case" },
    ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true, description: "Null: outside the UK or not known yet (see outsideUk)" },
    outsideUk: { type: "boolean", description: "True: the client said the case is outside the UK. False with a null ukJurisdiction: not known yet, so ask" },
    where: { type: "string", description: "Town or city, free text" },
    notes: { type: "string", description: "What happened and what the client wants, in their words" },
    side: { type: "string", enum: ["CLAIMANT", "RESPONDENT"], nullable: true },
    others: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string", enum: [...CLIENT_PARTY_ROLES] } } },
    },
    documents: { type: "array", items: clientDocument },
    credits: { type: "integer", description: "Chat credits left; each message to the AI uses one" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const overviewPoint = {
  type: "object",
  properties: { id: { type: "string" }, title: { type: "string" }, detail: { type: "string", nullable: true } },
};
const sectionStatus = { type: "string", enum: ["EMPTY", "RUNNING", "READY", "FAILED", "STALE"] };
/** The client app's Overview tab (ilovelawyer-api#571, C1). Mirrors src/types/client-overview.ts;
 * test/client-case-overview.spec.ts freezes the field list. Deliberately has no outlook, win
 * likelihood, strategy or attack/defense fields — those stay Terminal-only. */
const caseOverview = {
  type: "object",
  properties: {
    generatedAt: { type: "string", format: "date-time", nullable: true },
    job: {
      type: "object",
      nullable: true,
      description: "The live generate job; null when nothing is running",
      properties: {
        startedAt: { type: "string", format: "date-time" },
        panesDone: { type: "array", items: { type: "string", enum: ["strategy", "findings", "missingEvidence"] } },
      },
    },
    changedSince: {
      type: "object",
      nullable: true,
      description: "READY documents added or removed since generatedAt; null when nothing changed",
      properties: { added: { type: "integer" }, removed: { type: "integer" } },
    },
    updates: {
      type: "object",
      properties: {
        allowed: { type: "boolean", description: "False while a job is running" },
        leftToday: { type: "integer", description: "Generate/Update presses left today (D1)" },
      },
    },
    sections: {
      type: "object",
      description: "Each section's own status. keyDates is only READY or EMPTY, and is absent outside the UK.",
      properties: Object.fromEntries(["summary", "timeline", "keyDates", "toGather", "helps", "mayHurt"].map((k) => [k, sectionStatus])),
    },
    summary: { type: "string", nullable: true },
    timeline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          date: { type: "string", format: "date-time", nullable: true },
          label: { type: "string" },
          sourceDocumentId: { type: "string", nullable: true, description: "Null when the document is no longer on the case" },
          sourceDocumentName: { type: "string", nullable: true },
        },
      },
    },
    keyDates: {
      type: "array",
      description: "Procedural deadlines. Absent for a case outside the UK (D5).",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          date: { type: "string", format: "date-time" },
          status: { type: "string", enum: ["CONFIRMED", "ESTIMATED"] },
        },
      },
    },
    toGather: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, why: { type: "string" } } },
    },
    helps: { type: "array", items: overviewPoint },
    mayHurt: { type: "array", items: overviewPoint },
  },
};

const ADMIN_TAG = "Admin: Client Billing";
const pageParams = [
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
];
const billingFilters = [
  { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Inclusive. Default: 30 days before `to` (or now)" },
  { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "Exclusive" },
  { name: "userId", in: "query", schema: { type: "string" } },
  { name: "caseId", in: "query", schema: { type: "string" } },
  { name: "status", in: "query", schema: paymentStatus },
  { name: "kind", in: "query", schema: { type: "string", enum: ["CASE", "TOP_UP"] } },
  { name: "provider", in: "query", schema: { type: "string", enum: ["DUMMY", "STRIPE", "FREE"] } },
  { name: "q", in: "query", schema: { type: "string" }, description: "Part of the client's email or name, any case" },
];
const moneyGroup = { type: "object", properties: { key: { type: "string" }, amount: money, payments: { type: "integer" } } };
const billingTotals = {
  type: "array",
  description: "One row per currency. Paid counts SUCCEEDED payments; refunded and net count the refunds of those payments.",
  items: {
    type: "object",
    properties: { currency: { type: "string" }, paid: money, payments: { type: "integer" }, refunded: money, refundPending: money, net: money },
  },
};
const statusCounts = { type: "object", properties: { PENDING: { type: "integer" }, SUCCEEDED: { type: "integer" }, FAILED: { type: "integer" } } };
const adminClientPayment = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["CASE", "TOP_UP"] },
    status: paymentStatus,
    provider: { type: "string", enum: ["DUMMY", "STRIPE", "FREE"], description: "DUMMY and FREE took no money" },
    externalId: { type: "string", nullable: true, description: "Stripe Checkout Session id (cs_...), or the dummy's" },
    amount: money,
    credits: { type: "integer" },
    promoCode: { type: "string", nullable: true },
    failureReason: { type: "string", nullable: true },
    usedAt: { type: "string", format: "date-time", nullable: true, description: "When a case payment created its case (CASE rows are history: cases are free now)" },
    createdAt: { type: "string", format: "date-time" },
    client: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string", nullable: true } } },
    case: { type: "object", nullable: true, properties: { id: { type: "string" }, title: { type: "string" } } },
    refunded: money,
    refundPending: money,
    refundable: { ...money, description: "What a refund can still give back; 0 when the payment can't be refunded" },
    refunds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          amount: money,
          reason: { type: "string" },
          status: { type: "string", enum: ["PENDING", "SUCCEEDED", "FAILED"] },
          externalId: { type: "string", nullable: true, description: "Stripe refund id (re_...)" },
          failureReason: { type: "string", nullable: true },
          admin: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string", nullable: true } } },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
};
const paymentPage = {
  type: "object",
  properties: { rows: { type: "array", items: adminClientPayment }, total: { type: "integer" }, page: { type: "integer" }, pageSize: { type: "integer" }, totalPages: { type: "integer" } },
};

export const clientAppPaths: Paths = {
  "/client/pricing": {
    get: {
      tags: [TAG],
      summary: "The chat credits a new (free) case starts with, and the top-up packs",
      security,
      responses: {
        200: {
          description: "Pricing",
          content: json({
            type: "object",
            properties: {
              case: { type: "object", properties: { credits: { type: "integer", description: "Chat credits a new case starts with. Cases are free." } } },
              topUpPacks: {
                type: "array",
                items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, credits: { type: "integer" }, price: money } },
              },
              defaultPackId: { type: "string" },
            },
          }),
        },
      },
    },
  },
  "/client/payments/top-up/quote": {
    post: {
      tags: [TAG],
      summary: "What a top-up pack costs, with a promo code applied if it can be",
      security,
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["packId"], properties: { packId: { type: "string" }, promoCode: { type: "string" } } }),
      },
      responses: {
        200: {
          description: "Quote",
          content: json({
            type: "object",
            properties: {
              packId: { type: "string" },
              price: money,
              discount: money,
              total: money,
              credits: { type: "integer" },
              promo: {
                type: "object",
                nullable: true,
                properties: { code: { type: "string" }, applied: { type: "boolean" }, message: { type: "string" } },
              },
            },
          }),
        },
        400: err("No such pack"),
      },
    },
  },
  "/client/payments/{paymentId}": {
    get: {
      tags: [TAG],
      summary: "Where one of the client's payments stands",
      description:
        "A PENDING Stripe payment is checked with Stripe first and settled if the client has paid (or the page expired), so the app learns the outcome straight away instead of waiting for the webhook.",
      security,
      parameters: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: {
          description: "Payment",
          content: json({
            type: "object",
            properties: {
              paymentId: { type: "string" },
              kind: { type: "string", enum: ["CASE", "TOP_UP"] },
              status: paymentStatus,
              amount: money,
              credits: { type: "integer" },
              caseId: { type: "string", nullable: true },
              failureReason: { type: "string", nullable: true },
            },
          }),
        },
        404: err("Not one of this client's payments"),
      },
    },
  },
  "/client/cases/{caseId}/lawyer-readiness": {
    get: {
      tags: [TAG],
      summary: "Whether the case has enough in it to suggest a lawyer, and what's still missing",
      description:
        "Jev checks five points against the case and its chat, once per AI answer (stored, so asking again is free). `enabled` is false when USE_JEV_LAWYER_READINESS is off. `unavailable` means Jev couldn't be reached: never read it as ready.",
      security,
      parameters: [caseId],
      responses: {
        200: {
          description: "Readiness",
          content: json({
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              ready: { type: "boolean" },
              criteria: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string", enum: ["problem", "place", "otherSide", "events", "goal"] },
                    label: { type: "string" },
                    met: { type: "boolean" },
                    confidence: { type: "number" },
                  },
                },
              },
              caseAreas: {
                type: "array",
                description:
                  "The case areas Jev is sure the problem falls under. Once ready, they replace the case's own. Empty before Jev has looked, or when it's sure of none",
                items: { type: "object", properties: { code: { type: "string" }, name: { type: "string" }, confidence: { type: "number" } } },
              },
              ukJurisdiction: { type: "string", nullable: true },
              blockedBy: {
                type: "string",
                enum: ["OUTSIDE_UK", "PERSONAL_INJURY"],
                nullable: true,
                description: "OUTSIDE_UK only when the client said so. A case whose part of the UK isn't known yet isn't blocked: it's not ready, with the place criterion unmet",
              },
              unavailable: { type: "boolean" },
              checkedAt: { type: "string", format: "date-time", nullable: true },
              basedOnMessageId: { type: "string", nullable: true },
            },
          }),
        },
        403: err("CONSENT_REQUIRED (AI processing withdrawn)"),
        404: err("Not one of this client's cases"),
      },
    },
  },
  "/client/cases/{caseId}/top-ups": {
    post: {
      tags: [TAG],
      summary: "Buy chat credits for a case",
      description:
        "With the dummy the credits are added at once. With Stripe the payment starts PENDING with a `checkout`, and the credits are added when it settles (webhook, or GET /client/payments/{paymentId}). A promo code that brings the total to 0 settles at once (provider FREE). No card details reach this API either way.",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["packId"], properties: { packId: { type: "string" }, promoCode: { type: "string" }, testOutcome } }),
      },
      responses: {
        201: {
          description: "Credits added",
          content: json({
            type: "object",
            properties: {
              paymentId: { type: "string" },
              status: paymentStatus,
              credits: { type: "integer", description: "The case's balance now (unchanged while a Stripe payment is PENDING)" },
              added: { type: "integer" },
              amount: money,
              checkout,
            },
          }),
        },
        400: err("No such pack, or PROMO_NOT_APPLIED: the code doesn't apply (nothing charged)"),
        402: err("PAYMENT_DECLINED"),
        404: err("Not one of this client's cases"),
        502: err("PAYMENT_PROVIDER_ERROR: Stripe couldn't open the payment page (the payment is marked FAILED)"),
      },
    },
  },
  "/client/cases": {
    get: {
      tags: [TAG],
      summary: "The client's cases, most recently changed first",
      security,
      parameters: [{ name: "archived", in: "query", schema: { type: "boolean", default: false }, description: "true: the archived cases instead" }],
      responses: { 200: { description: "Cases", content: json({ type: "array", items: clientCase }) }, 403: err("Not a client account") },
    },
    post: {
      tags: [TAG],
      summary: "Create a case (and its AI chat)",
      description: "Free. The case starts with the chat credits set for the client's tenant (GET /client/pricing `case.credits`).",
      security,
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["title", "areas", "ukJurisdiction"],
          properties: {
            title: { type: "string", maxLength: 150 },
            areas: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
              description: "Codes from GET /client/case-areas, one or more (400 UNKNOWN_CASE_AREA or CASE_AREA_INACTIVE otherwise)",
            },
            area: { type: "string", deprecated: true, description: "One code, taken as areas: [area]. Send areas or area, not both" },
            ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true },
            outsideUk: {
              type: "boolean",
              description: "With ukJurisdiction null: true is outside the UK, false is not known yet. Left out, null means outside the UK (older apps). Can't be true with a ukJurisdiction",
            },
            where: { type: "string" },
            side: { type: "string", enum: ["CLAIMANT", "RESPONDENT"], nullable: true },
            others: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string", enum: [...CLIENT_PARTY_ROLES] } } } },
            notes: { type: "string", maxLength: 2000, description: "What happened and what the client wants" },
          },
        }),
      },
      responses: {
        201: { description: "Created", content: json(clientCase) },
        400: err("Validation error"),
        403: err("Not a client account"),
      },
    },
  },
  "/client/limits": {
    get: {
      tags: [TAG],
      summary: "What the API accepts in an upload",
      security,
      responses: {
        200: {
          description: "Upload limits",
          content: json({ type: "object", properties: { upload: { type: "object", properties: { extensions: { type: "array", items: { type: "string" } }, maxBytes: { type: "integer" } } } } }),
        },
      },
    },
  },
  "/client/case-areas": {
    get: {
      tags: [TAG],
      summary: "The types of issue a case can be about",
      description: "Switched-on ones only, in the order admins set (ilovelawyer-admin manages them). A case picks one or more by code.",
      security,
      responses: {
        200: {
          description: "Case areas",
          content: json({ type: "array", items: { type: "object", properties: { code: { type: "string", example: "EMPLOYMENT" }, name: { type: "string", example: "Employment" } } } }),
        },
      },
    },
  },
  "/client/lawyers": {
    get: {
      tags: [TAG],
      summary: "The lawyer marketplace",
      description:
        "Verified UK lawyers taking requests: accepting, enabled by their firm, not paused and under capacity. Filters combine; `total` counts every lawyer they let through.",
      security,
      parameters: [
        { name: "area", in: "query", schema: { type: "string", example: "EMPLOYMENT" }, description: "A code from GET /client/case-areas: only lawyers who take it" },
        { name: "caseArea", in: "query", schema: { type: "string" }, description: "The client's case's area. Filters nothing; sort=match puts lawyers who take it first" },
        { name: "jurisdiction", in: "query", schema: { type: "string", enum: ["England and Wales", "Scotland", "Northern Ireland"] }, description: "Only lawyers qualified there" },
        { name: "maxConsultationMinor", in: "query", schema: { type: "integer", minimum: 0 }, description: "Pence. Only lawyers whose first consultation costs this or less; one who offers none is left out" },
        {
          name: "languages",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          style: "form",
          explode: true,
          description: "Speaks any of these. \"Other\": any language but English and Welsh",
        },
        { name: "q", in: "query", schema: { type: "string", maxLength: 100 }, description: "Part of the lawyer's name, firm or town, any case" },
        { name: "sort", in: "query", schema: { type: "string", enum: ["match", "rating", "price"], default: "match" }, description: "match: takes caseArea first, then highest rated. price: lowest first consultation fee" },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      ],
      responses: {
        200: {
          description: "A page of lawyers",
          content: json({
            type: "object",
            properties: {
              total: { type: "integer" },
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    avatarUrl: { type: "string", nullable: true },
                    firmName: { type: "string", nullable: true, description: "Null for a solo lawyer" },
                    town: { type: "string", nullable: true, description: "Their firm's city" },
                    regulator: { type: "string", enum: ["SRA", "LSS", "LSNI"], nullable: true },
                    registrationNumber: { type: "string", nullable: true },
                    practiceAreas: { type: "array", items: { type: "string" }, description: "By name, in the site's order" },
                    caseAreas: { type: "array", items: { type: "string" }, description: "Case area codes they take" },
                    qualifiedJurisdictions: { type: "array", items: { type: "string" } },
                    languages: { type: "array", items: { type: "string" } },
                    bio: { type: "string" },
                    firstConsultationFee: { ...money, nullable: true, description: "GBP. 0: free. Null: no first consultation offered" },
                    verifiedAt: { type: "string", format: "date-time", nullable: true },
                    rating: { type: "number", nullable: true, description: "Average of their clients' ratings (1-5), one decimal. Null with no reviews" },
                    reviewCount: { type: "integer" },
                  },
                },
              },
            },
          }),
        },
        400: err("A filter isn't valid"),
      },
    },
  },
  "/client/lawyers/{id}": {
    get: {
      tags: [TAG],
      summary: "One lawyer's marketplace profile",
      description:
        "What the list shows, plus how their ratings spread and their clients' latest comments (without the client's name). A verified lawyer who isn't taking requests right now is still shown, with available false.",
      security,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      responses: {
        200: {
          description: "The lawyer, as in GET /client/lawyers, with these too",
          content: json({
            type: "object",
            properties: {
              available: { type: "boolean", description: "Taking new requests now: accepting, enabled by their firm, not paused and under capacity" },
              ratingBreakdown: { type: "array", items: { type: "integer" }, minItems: 5, maxItems: 5, description: "How many ratings at 5, 4, 3, 2 and 1 stars" },
              reviews: {
                type: "array",
                description: "Up to 10 ratings with a comment, newest first",
                items: {
                  type: "object",
                  properties: {
                    rating: { type: "integer", minimum: 1, maximum: 5 },
                    comment: { type: "string" },
                    caseAreas: { type: "array", items: { type: "string" }, description: "The case's areas, by name" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          }),
        },
        404: err("LAWYER_NOT_FOUND: not a verified UK lawyer"),
      },
    },
  },
  "/client/cases/{caseId}": {
    get: {
      tags: [TAG],
      summary: "One of the client's cases",
      security,
      parameters: [caseId],
      responses: { 200: { description: "Case", content: json(clientCase) }, 404: err("Not one of this client's cases") },
    },
    patch: {
      tags: [TAG],
      summary: "Edit the case's details",
      description: "Send only what changes. Clears the stored lawyer-readiness check. While a lawyer holds the lawyer request the type of issue, the part of the UK and the people are fixed.",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          minProperties: 1,
          properties: {
            title: { type: "string", maxLength: 150 },
            areas: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
              description: "Replaces the case's areas. A switched-off one the case already has can stay",
            },
            area: { type: "string", deprecated: true, description: "One code, taken as areas: [area]" },
            ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true },
            outsideUk: {
              type: "boolean",
              description: "With ukJurisdiction null: true is outside the UK, false is not known yet. Left out, null means outside the UK (older apps). Can't be true with a ukJurisdiction",
            },
            where: { type: "string" },
            side: { type: "string", enum: ["CLAIMANT", "RESPONDENT"], nullable: true },
            others: { type: "array", description: "Replaces the whole list", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string", enum: [...CLIENT_PARTY_ROLES] } } } },
            notes: { type: "string", maxLength: 2000 },
          },
        }),
      },
      responses: {
        200: { description: "The updated case", content: json(clientCase) },
        400: err("Validation error"),
        404: err("Not one of this client's cases"),
        409: err("CASE_LOCKED_BY_REQUEST: a lawyer holds the request, or the case can't leave the UK while a request is open"),
      },
    },
    delete: {
      tags: [TAG],
      summary: "Delete the case, its chat and documents",
      description: "Withdraws an open lawyer request first. Payments stay on record and credits are not refunded.",
      security,
      parameters: [caseId],
      responses: {
        204: { description: "Deleted" },
        404: err("Not one of this client's cases"),
        409: err("CASE_HAS_ACTIVE_ENGAGEMENT: a lawyer is confirmed or engaged; end the engagement first"),
      },
    },
  },
  "/client/cases/{caseId}/archive": {
    post: {
      tags: [TAG],
      summary: "Set the case aside (out of the list, restorable)",
      security,
      parameters: [caseId],
      responses: { 204: { description: "Archived" }, 404: err("Not one of this client's cases"), 409: err("CASE_HAS_ACTIVE_ENGAGEMENT") },
    },
  },
  "/client/cases/{caseId}/unarchive": {
    post: {
      tags: [TAG],
      summary: "Bring an archived case back",
      security,
      parameters: [caseId],
      responses: { 200: { description: "The restored case", content: json(clientCase) }, 404: err("Not one of this client's cases") },
    },
  },
  "/client/cases/{caseId}/messages": {
    get: {
      tags: [TAG],
      summary: "The case's AI chat, oldest first",
      description: "Poll while `replying` is true: the answer is generated in the background.",
      security,
      parameters: [caseId],
      responses: {
        200: {
          description: "Messages",
          content: json({
            type: "object",
            properties: {
              replying: { type: "boolean" },
              messages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    role: { type: "string", enum: ["user", "ai"] },
                    text: { type: "string" },
                    replyStatus: { type: "string", enum: ["PENDING", "DONE", "FAILED", "CANCELLED"], nullable: true, description: "Set on the client's own message (which turn this is); always null on the AI's" },
                    documentIds: {
                      type: "array",
                      items: { type: "string" },
                      description: "The case documents sent with a user message, by id. Always empty on the AI's",
                    },
                    suggestions: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "#158: 2-4 short tappable replies to the question this AI message just asked, worded exactly as the client could say them. Empty — never omitted — when CW isn't confident enough to suggest anything; always empty on the client's own message. Tapping one sends it as an ordinary chat message, same as typing or speaking it.",
                    },
                    audioUrl: { type: "string", nullable: true, description: "Playable audio: the client's own recording on a voice-originated user message, or Polly's synthesized reply on its answer" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          }),
        },
        404: err("Not one of this client's cases"),
      },
    },
    post: {
      tags: [TAG],
      summary: "Ask the AI about the case",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", maxLength: 4000 },
            documentIds: { type: "array", maxItems: 5, items: { type: "string" }, description: "The case's documents to send with this message. Each must be READY" },
          },
        }),
      },
      responses: {
        202: { description: "Queued; the answer appears in GET messages. Uses one chat credit, given back if the answer fails or is stopped" },
        402: err("OUT_OF_CREDITS: top up the case"),
        403: err("CONSENT_REQUIRED (AI processing withdrawn)"),
        404: err("Not one of this client's cases, or a documentId that isn't on this case"),
        409: err(
          "DOCUMENTS_NOT_READY: a document is still being read or couldn't be read; `message` names them and `documents` lists { id, name, status }. Otherwise a reply is already generating. Neither uses a credit",
        ),
      },
    },
  },
  "/client/cases/{caseId}/voice-messages/presign": {
    post: {
      tags: [TAG],
      summary: "Step 1 of a voice message: a URL to PUT the recording to S3",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["contentType"], properties: { contentType: { type: "string" }, fileSize: { type: "integer" } } }),
      },
      responses: {
        200: { description: "Upload URL", content: json({ type: "object", properties: { uploadUrl: { type: "string" }, key: { type: "string" } } }) },
        404: err("Not one of this client's cases"),
      },
    },
  },
  "/client/cases/{caseId}/voice-messages": {
    post: {
      tags: [TAG],
      summary: "Step 2: ask the AI with the uploaded recording",
      description:
        "Transcribed (Amazon Transcribe) before the AI answers; the transcript appears in GET messages as soon as it's ready, ahead of the AI's reply. The reply's own audio (Polly) lands at the same time as chat:done.",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["key"], properties: { key: { type: "string", description: "From voice-messages/presign" } } }),
      },
      responses: {
        202: { description: "Queued; the transcript and then the answer appear in GET messages. Uses one chat credit, given back if the answer fails or is stopped" },
        402: err("OUT_OF_CREDITS: top up the case"),
        403: err("CONSENT_REQUIRED (AI processing withdrawn)"),
        404: err("Not one of this client's cases"),
        409: err("A reply is already generating for this case. Doesn't use a credit"),
      },
    },
  },
  "/client/cases/{caseId}/messages/{messageId}/cancel": {
    post: {
      tags: [TAG],
      summary: "Stop the answer to a message (the Stop button)",
      description:
        "`messageId` is the client's own message. What was written so far is kept as the answer (`assistantMessageId`, absent when nothing was written yet), the message's credit is given back, and chat:cancelled is sent over the socket. Stopping an answer that has already finished, failed or been stopped changes nothing and gives nothing back: the response then carries its current `replyStatus`.",
      security,
      parameters: [caseId, messageId],
      responses: {
        200: {
          description: "The message's reply status after the Stop",
          content: json({
            type: "object",
            required: ["messageId", "replyStatus"],
            properties: {
              messageId: { type: "string" },
              replyStatus: { type: "string", enum: ["PENDING", "DONE", "FAILED", "CANCELLED"], nullable: true },
              assistantMessageId: { type: "string", description: "The partial answer kept, when there was one" },
            },
          }),
        },
        404: err("Not one of this client's cases, or not one of the client's messages on it"),
      },
    },
  },
  "/client/cases/{caseId}/messages/{messageId}": {
    delete: {
      tags: [TAG],
      summary: "Delete a message from the case's chat",
      description:
        "Deleting the client's own message deletes the answer to it too; deleting an answer deletes just that answer. A voice message's recordings are deleted with it. The AI forgets what was deleted: its next answer is based on the chat as it now stands. No credit is given back.",
      security,
      parameters: [caseId, messageId],
      responses: {
        204: { description: "Deleted" },
        404: err("Not one of this client's cases, or not a message on it"),
        409: err("TURN_IN_PROGRESS: an answer in this case is still being written. Stop it first"),
      },
    },
  },
  "/client/cases/{caseId}/documents/presign": {
    post: {
      tags: [TAG],
      summary: "Step 1 of an upload: a URL to PUT the file to S3",
      description:
        "#159: evidence images and PDFs use this same upload path as any other document — there is no separate evidence-only endpoint. Supported extensions: pdf, doc, docx, xlsx, xlsm, xlam, txt, jpg, jpeg, png, webp, heic, mp3, mp4, m4a, wav (document-upload.constants.ts's ALLOWED_DOCUMENT_EXTENSIONS, enforced server-side regardless of what the client already filters to). Size limit: 1 GB total per presign/confirm request (DOCUMENT_UPLOAD_BATCH_MAX_BYTES) — also the effective largest single file, since there's no separate per-file cap.",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["filename", "contentType"], properties: { filename: { type: "string" }, contentType: { type: "string" }, fileSize: { type: "integer" } } }),
      },
      responses: {
        200: { description: "Upload URL", content: json({ type: "object", properties: { uploadUrl: { type: "string" }, key: { type: "string" } } }) },
        404: err("Not one of this client's cases"),
      },
    },
  },
  "/client/cases/{caseId}/documents": {
    post: {
      tags: [TAG],
      summary: "Step 2: record the uploaded file on the case and start reading it",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["key", "name"],
          properties: {
            key: { type: "string" },
            name: { type: "string" },
            contentType: { type: "string" },
            fileSize: { type: "integer" },
            missingEvidenceId: {
              type: "string",
              description:
                "#159: the client's explicit \"this fills that gap\" action (from GET .../missing-evidence's gaps list) — never AI-matched. Silently ignored if it doesn't name an open gap on this case, same as any other id a client could tamper with.",
            },
          },
        }),
      },
      responses: { 201: { description: "Added (status PENDING until it's read)", content: json(clientDocument) }, 404: err("Not one of this client's cases") },
    },
  },
  "/client/cases/{caseId}/documents/{documentId}": {
    delete: {
      tags: [TAG],
      summary: "Remove a document from the case for good",
      description:
        "Deletes the document and its file, and unlinks it from the overview's timeline. If it was READY, the overview reads STALE until it's updated. An engaged lawyer gets engagement:document-removed.",
      security,
      parameters: [caseId, documentId],
      responses: { 204: { description: "Removed" }, 404: err("Not one of this client's cases, or not a document on it") },
    },
  },
  "/client/cases/{caseId}/documents/{documentId}/url": {
    get: {
      tags: [TAG],
      summary: "A short-lived link that opens the document in the browser",
      security,
      parameters: [caseId, documentId],
      responses: {
        200: {
          description: "A same-origin /files/<token> path, good for five minutes. Fetch a new one for each open.",
          content: json({ type: "object", properties: { url: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } }),
        },
        404: err("Not one of this client's cases, or not a document on it"),
      },
    },
  },
  "/client/cases/{caseId}/documents/{documentId}/retry": {
    post: {
      tags: [TAG],
      summary: "Read a document that couldn't be read again",
      security,
      parameters: [caseId, documentId],
      responses: {
        200: { description: "Queued again (status PENDING)", content: json(clientDocument) },
        404: err("Not one of this client's cases, or not a document on it"),
        409: err("NOT_FAILED: only a FAILED document can be retried"),
      },
    },
  },
  "/client/cases/{caseId}/missing-evidence": {
    get: {
      tags: [TAG],
      summary: "#159: the case's open evidence gaps, in order, plus what to upload next",
      description:
        "Ordering rule (the ticket's own open question, now settled): open gaps first, then most severe (CRITICAL, MODERATE, MINOR), then newest first within the same severity — MissingEvidenceRepo.list's existing sort, not a new one. `suggestion` is CW's pick of which still-unfilled gap to ask for next, from the same list; null when CW isn't confident or the call fails (never blocks or delays this response). Requires AI_PROCESSING consent, since picking a suggestion calls CW.",
      security,
      parameters: [caseId],
      responses: {
        200: {
          description: "Open gaps and a suggestion",
          content: json({
            type: "object",
            properties: {
              gaps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    detail: { type: "string", nullable: true },
                    severity: { type: "string", enum: ["CRITICAL", "MODERATE", "MINOR"] },
                    suggestedSource: { type: "string", nullable: true },
                    filledByDocumentId: { type: "string", nullable: true, description: "Set once a document has been uploaded for this gap via missingEvidenceId" },
                    filledAt: { type: "string", format: "date-time", nullable: true },
                  },
                },
              },
              suggestion: {
                type: "object",
                nullable: true,
                properties: { gapId: { type: "string" }, message: { type: "string" } },
              },
            },
          }),
        },
        403: err("AI processing consent not given yet, or this client site has AI features turned off"),
        404: err("Not one of this client's cases"),
      },
    },
  },
  "/client/gmail/connect": {
    post: {
      tags: [TAG],
      summary: "Connect Gmail (read-only) with a code from Google's auth-code popup",
      security,
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["code"], properties: { code: { type: "string", description: "From useGoogleLogin({ flow: \"auth-code\", scope: gmail.readonly })" } } }),
      },
      responses: {
        200: { description: "The signed-in user, now with gmailConnected and gmailEmail" },
        400: err("Google refused the code, GMAIL_SCOPE_MISSING (Gmail access unticked), or no offline access"),
        502: err("Couldn't read the Gmail profile"),
        503: err("GMAIL_UNAVAILABLE: token encryption isn't configured on this server"),
      },
    },
  },
  "/client/gmail": {
    delete: {
      tags: [TAG],
      summary: "Disconnect Gmail: revokes the grant at Google and forgets the tokens",
      security,
      responses: { 200: { description: "The signed-in user, with gmailConnected false" } },
    },
  },
  "/client/gmail/messages": {
    get: {
      tags: [TAG],
      summary: "Search the connected inbox (Gmail search syntax), newest first. Nothing is stored.",
      security,
      parameters: [
        { name: "q", in: "query", schema: { type: "string", maxLength: 500 }, description: "e.g. from:landlord@example.com has:attachment newer_than:1y" },
        { name: "pageToken", in: "query", schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
      ],
      responses: {
        200: {
          description: "One page of results",
          content: json({
            type: "object",
            properties: {
              messages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    threadId: { type: "string" },
                    from: { type: "string", nullable: true },
                    to: { type: "string", nullable: true },
                    subject: { type: "string", nullable: true },
                    date: { type: "string", format: "date-time", nullable: true },
                    snippet: { type: "string" },
                    attachmentNames: { type: "array", items: { type: "string" } },
                  },
                },
              },
              nextPageToken: { type: "string", nullable: true },
            },
          }),
        },
        409: err("GMAIL_NOT_CONNECTED or GMAIL_RECONNECT_REQUIRED"),
        429: err("Too many Gmail calls in a minute"),
        502: err("Gmail couldn't be reached"),
      },
    },
  },
  "/client/gmail/messages/{messageId}": {
    get: {
      tags: [TAG],
      summary: "One email in full: headers (Bcc only on sent mail), plain and HTML bodies, attachment list",
      security,
      parameters: [{ name: "messageId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        200: { description: "The email. Attachments are listed with a partId for the download route." },
        404: err("GMAIL_NOT_FOUND"),
        409: err("GMAIL_NOT_CONNECTED or GMAIL_RECONNECT_REQUIRED"),
      },
    },
  },
  "/client/gmail/messages/{messageId}/attachments/{partId}/download": {
    get: {
      tags: [TAG],
      summary: "One attachment's file, with its Gmail filename and type",
      security,
      parameters: [
        { name: "messageId", in: "path", required: true, schema: { type: "string" } },
        { name: "partId", in: "path", required: true, schema: { type: "string" }, description: "From the message's attachments list" },
      ],
      responses: {
        200: { description: "The file bytes (Content-Disposition: attachment)" },
        404: err("GMAIL_NOT_FOUND"),
        409: err("GMAIL_NOT_CONNECTED or GMAIL_RECONNECT_REQUIRED"),
      },
    },
  },
  "/client/cases/{caseId}/overview": {
    get: {
      tags: [TAG],
      summary: "The Overview tab's content and status — a plain read, no AI call",
      security,
      parameters: [caseId],
      responses: { 200: { description: "Overview", content: json(caseOverview) }, 404: err("Not one of this client's cases") },
    },
  },
  "/client/cases/{caseId}/overview/generate": {
    post: {
      tags: [TAG],
      summary: "Generate (first run) or Update (after STALE) the Overview. Two quick requests start one job.",
      security,
      parameters: [caseId],
      responses: {
        202: { description: "The job has started (or was already running)", content: json(caseOverview) },
        402: err("The case's AI usage budget for the overview is used up"),
        403: err("AI processing consent has been withdrawn"),
        404: err("Not one of this client's cases"),
        429: err("Today's update limit for this case has been used (the body's nextUpdateAt says when it resets)"),
      },
    },
  },
  "/client/cases/{caseId}/export": {
    get: {
      tags: [TAG],
      summary: "Download the case summary: the client's case as a PDF they can keep or take to any lawyer",
      description: [
        "Built at request time from the stored intake (GET /client/cases/{caseId}/intake) and the case details — a plain read: never starts an AI run, never spends chat credits, needs no AI-processing consent.",
        "",
        "Contains only what the client entered or uploaded and what the intake gathered from it: title, type of issue, part of the UK (UK site only), where, the intake's summary paragraph (tagged \"AI-written · check it against what you said\", as on the Overview), the client's own description, people and organisations, timeline, facts, what they want, concerns, questions for a lawyer, deadlines exactly as stated (with their sources, never computed), missing information, conflicting accounts, uploaded document names (not the files), an \"as of\" date and the line \"Prepared from the information you gave us. It isn't legal advice.\" Never an assessment (ADR 0018): no strengths, weaknesses, strategy, outlook or chat transcript.",
        "",
        "The PDF is the response body; nothing is stored. The filename (case-summary-<title>-<YYYY-MM-DD>.pdf, dated on the site's calendar) is in Content-Disposition, exposed to the browser. Each download writes an export.case_summary security audit row. Limited to 30 per account per 10 minutes.",
      ].join("\n"),
      security,
      parameters: [
        caseId,
        { name: "format", in: "query", required: false, schema: { type: "string", enum: ["pdf"], default: "pdf" }, description: "PDF only for now" },
        {
          name: "lang",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["en", "ko"], default: "en" },
          description: "The language of the document's own labels (the client app's current language). The client's words are printed as they wrote them.",
        },
      ],
      responses: {
        200: {
          description: "The PDF (Content-Disposition: attachment; filename=…; filename*=UTF-8''…)",
          content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
        },
        400: err("format or lang isn't one of the allowed values"),
        404: err("Not one of this client's cases"),
        409: err("INTAKE_RUNNING: the overview is still being prepared, try again shortly. INTAKE_EMPTY: nothing gathered yet, so nothing to summarise"),
        429: err("Too many downloads just now"),
      },
    },
  },
  // ── Admin: client billing (ilovelawyer-admin, ADMIN accounts only) ───────
  "/admin/billing/summary": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Client app revenue, refunds and splits over a range",
      description: "Over SUCCEEDED payments in the filter. DUMMY payments count unless `provider` narrows them out: byProvider shows how much of the total is fake money.",
      security,
      parameters: billingFilters,
      responses: {
        200: {
          description: "Summary",
          content: json({
            type: "object",
            properties: {
              range: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time", nullable: true } } },
              totals: billingTotals,
              counts: { ...statusCounts, description: "Every payment in the filter, by status" },
              byKind: { type: "array", items: moneyGroup },
              byProvider: { type: "array", items: moneyGroup },
              byDay: { type: "array", items: { type: "object", properties: { day: { type: "string", format: "date" }, amount: money, payments: { type: "integer" } } } },
            },
          }),
        },
        400: err("A bad filter, or `from` not before `to`"),
        403: err("Not an admin"),
      },
    },
  },
  "/admin/billing": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Client app payments, newest first",
      security,
      parameters: [...billingFilters, ...pageParams],
      responses: { 200: { description: "One page", content: json(paymentPage) }, 400: err("A bad filter"), 403: err("Not an admin") },
    },
  },
  "/admin/billing/clients/{userId}": {
    get: {
      tags: [ADMIN_TAG],
      summary: "One client's billing, all time",
      security,
      parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }, ...pageParams],
      responses: {
        200: {
          description: "Client",
          content: json({
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string", nullable: true }, role: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
              },
              totals: billingTotals,
              counts: statusCounts,
              cases: {
                type: "array",
                items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, credits: { type: "integer" }, createdAt: { type: "string", format: "date-time" } } },
              },
              payments: paymentPage,
            },
          }),
        },
        403: err("Not an admin"),
        404: err("No such user"),
      },
    },
  },
  "/admin/billing/{paymentId}": {
    get: {
      tags: [ADMIN_TAG],
      summary: "One payment with its refunds",
      security,
      parameters: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Payment", content: json(adminClientPayment) }, 403: err("Not an admin"), 404: err("No such payment") },
    },
  },
  "/admin/billing/{paymentId}/refund": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Refund a client app payment through Stripe",
      description:
        "Full when amountMinor is left out, otherwise partial; more partial refunds may follow until nothing is left. Only a SUCCEEDED STRIPE payment: DUMMY and FREE took no money. Gives back money only: the case and its credits stay. A refund Stripe hasn't finished stays PENDING until its refund.updated webhook. Audited as admin.client_payment.refunded, a failure included.",
      security,
      parameters: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["reason"],
          properties: { amountMinor: { type: "integer", minimum: 1, description: "Cents. Left out: all that's left" }, reason: { type: "string", maxLength: 500 } },
        }),
      },
      responses: {
        200: { description: "The payment, with the new refund", content: json(adminClientPayment) },
        400: err("No reason, a bad amount, or REFUND_EXCEEDS_PAYMENT"),
        403: err("Not an admin"),
        404: err("No such payment"),
        409: err("REFUND_NOT_SUPPORTED (DUMMY or FREE), PAYMENT_NOT_REFUNDABLE (not SUCCEEDED) or ALREADY_REFUNDED"),
        502: err("PAYMENT_PROVIDER_ERROR: Stripe refused; the refund is recorded FAILED and nothing is held"),
      },
    },
  },
  "/client/cases/{caseId}/intake": {
    get: {
      tags: [TAG],
      summary: "The case's Intake tab: an AI extraction of the chat and READY documents, including #157's formFields view",
      security,
      parameters: [caseId],
      responses: { 200: { description: "Intake", content: json(caseIntake) }, 404: err("Case not found") },
    },
  },
  "/client/cases/{caseId}/intake/refresh": {
    post: {
      tags: [TAG],
      summary: "Re-runs the Intake extraction now, instead of waiting for the next automatic trigger (a chat reply, a document going READY, a case-details edit)",
      security,
      parameters: [caseId],
      responses: {
        200: { description: "Intake (RUNNING if a run was just queued)", content: json(caseIntake) },
        402: err("INTAKE_BUDGET_REACHED: this case has reached its AI usage limit for the intake summary"),
        404: err("Case not found"),
        429: err("INTAKE_DAILY_LIMIT: today's update limit for this case's intake summary is used up"),
      },
    },
  },
  "/client/cases/story": {
    post: {
      tags: [TAG],
      summary: "The story-first way in: make a case from the client's story and start reading it",
      description:
        "Creates a case with placeholder details (area OTHER, place not known yet) and keeps the story as its first chat message, with no AI reply. The Intake extraction then reads it in the background: poll GET /client/cases/{caseId}/intake until READY or FAILED. No chat credit is spent; the reading counts toward the case's AI budget, never the daily Update limit.",
      security,
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: CLIENT_STORY_MIN_LENGTH, maxLength: CLIENT_STORY_MAX_LENGTH, description: "What happened, typed or dictated" } },
        }),
      },
      responses: {
        202: {
          description: "The case, the story's message id, and the intake (RUNNING once the reading is queued)",
          content: json({ type: "object", properties: { case: clientCase, messageId: { type: "string" }, intake: caseIntake } }),
        },
        400: err("Validation error"),
        403: err("CLIENT_AI_NOT_OPEN: the AI isn't available on this site yet; CONSENT_REQUIRED: AI processing or sensitive information isn't agreed to"),
        429: err("Too many stories in a short time"),
      },
    },
  },
  "/client/cases/{caseId}/evidence-suggestions": {
    get: {
      tags: [TAG],
      summary: "The proof suggested for the case, without writing any",
      description: "A plain read: never calls the AI. null when nothing has been suggested yet.",
      security,
      parameters: [caseId],
      responses: { 200: { description: "The suggestions (as POST), or null" }, 404: err("Case not found") },
    },
    post: {
      tags: [TAG],
      summary: "The evidence step: suggest the proof the case needs, or return what was suggested",
      description:
        "The first call asks the AI once, reading the client's story and answers, for 2 to 5 pieces of proof in the story's language, saved as the case's evidence gaps (the lawyer sees them too). A reply with too few usable ones gets the app's general suggestions. Later calls return the same ones, with whether a document fills each (an upload sending its id as missingEvidenceId) or the client said they don't have it. No chat credit is spent.",
      security,
      parameters: [caseId],
      responses: {
        200: {
          description: "The suggestions",
          content: json({
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Send as missingEvidenceId with the upload that fills it" },
                    title: { type: "string" },
                    why: { type: "string" },
                    source: { type: "string", enum: ["photos", "files", "email", "memo"] },
                    state: { type: "string", enum: ["OPEN", "ADDED", "DISMISSED"] },
                    documentId: { type: "string", nullable: true },
                  },
                },
              },
              added: { type: "integer" },
              open: { type: "integer" },
            },
          }),
        },
        403: err("CLIENT_AI_NOT_OPEN or CONSENT_REQUIRED"),
        404: err("Case not found"),
        429: err("Too many tries in a short time"),
        502: err("EVIDENCE_FAILED: suggestions couldn't be written just now (nothing is saved; try again)"),
      },
    },
  },
  "/client/cases/{caseId}/evidence/done": {
    post: {
      tags: [TAG],
      summary: "The evidence step's Done: the client has added what they have",
      description: "The intake reading runs once over the new proof and its notes (skipped when nothing changed). Returns the suggestions, or null when there are none.",
      security,
      parameters: [caseId],
      responses: { 200: { description: "The suggestions, or null" }, 403: err("CLIENT_AI_NOT_OPEN or CONSENT_REQUIRED"), 404: err("Case not found") },
    },
  },
  "/client/cases/{caseId}/documents/{documentId}/note": {
    patch: {
      tags: [TAG],
      summary: "The client's own note on one of their documents",
      description:
        "Replaces the note the AI drafted once the document was read (the case's document list shows `note` and `noteBy`: AI or CLIENT). Empty clears it, and the AI doesn't draft another.",
      security,
      parameters: [caseId, { name: "documentId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: json({ type: "object", required: ["note"], properties: { note: { type: "string", maxLength: 500 } } }) },
      responses: {
        200: { description: "The saved note", content: json({ type: "object", properties: { documentId: { type: "string" }, note: { type: "string", nullable: true }, noteBy: { type: "string", enum: ["CLIENT"] } } }) },
        400: err("Validation error"),
        404: err("Case or document not found"),
      },
    },
  },
  "/client/cases/{caseId}/evidence-suggestions/{suggestionId}": {
    patch: {
      tags: [TAG],
      summary: "\"I don't have this\" on a suggestion, or taking it back",
      description: "The gap stays open for the lawyer, who knows to ask about it. Returns the suggestions.",
      security,
      parameters: [caseId, { name: "suggestionId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: json({ type: "object", required: ["dismissed"], properties: { dismissed: { type: "boolean" } } }) },
      responses: { 200: { description: "The suggestions" }, 400: err("Validation error"), 404: err("Case or suggestion not found") },
    },
  },
  "/client/cases/{caseId}/questions": {
    get: {
      tags: [TAG],
      summary: "Where the case's questions are, without starting them",
      description: "A plain read for the case page's \"questions left\" banner: never writes a list or calls the AI. null when the case has no list yet, or it's still being written.",
      security,
      parameters: [caseId],
      responses: {
        200: { description: "The same state as POST (status, total, answered, skipped, current, history), or null" },
        404: err("Case not found"),
      },
    },
    post: {
      tags: [TAG],
      summary: "The Questions step: start the details the case still needs, or pick them up where the client left off",
      description:
        "The first call writes the case's list once: the details still open (from the intake reading's formFields.missing and the unmet lawyer-readiness points, from a fixed set, at most six, place first and what the client wants last), each worded for this client by one AI call. On a UK case with no part of the UK, the place question is the app's own, with fixed chips. Later calls return the same list. No chat credit is spent.",
      security,
      parameters: [caseId],
      responses: {
        200: {
          description: "Where the questions are. `total` is fixed when the list is written (0 when nothing needed asking, with status DONE).",
          content: json({
            type: "object",
            properties: {
              status: { type: "string", enum: ["OPEN", "DONE"] },
              total: { type: "integer" },
              answered: { type: "integer" },
              skipped: { type: "integer" },
              current: {
                type: "object",
                nullable: true,
                properties: {
                  id: { type: "string" },
                  detail: { type: "string", enum: ["place", "otherSide", "relationship", "terms", "reasonGiven", "status", "witnesses", "goal"] },
                  question: { type: "string" },
                  why: { type: "string" },
                  chips: { type: "array", maxItems: 4, items: { type: "string" }, description: "Empty when the question has no natural short answers" },
                  followUp: { type: "boolean", description: "A follow-up within the same detail (its id is \"<detail>.followUp\"); it doesn't move the progress bar" },
                },
              },
              history: {
                type: "array",
                items: { type: "object", properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" }, answer: { type: "string", nullable: true }, skipped: { type: "boolean" } } },
              },
            },
          }),
        },
        403: err("CLIENT_AI_NOT_OPEN or CONSENT_REQUIRED"),
        404: err("Case not found"),
        409: err("INTAKE_RUNNING: the story is still being read; QUESTIONS_PREPARING: the list is being written by another request"),
        429: err("Too many tries in a short time"),
        502: err("QUESTIONS_FAILED: the list couldn't be written just now (nothing is saved; try again)"),
      },
    },
  },
  "/client/cases/{caseId}/questions/answer": {
    post: {
      tags: [TAG],
      summary: "Answer the question the client is on",
      description:
        "Kept on the list and in the case's chat (the question, then the answer), with no AI reply asked for. A place answer goes onto the case (a UK part of the UK, or outside the UK, then the town; a KR town). It may lead to one follow-up within the same detail: the list's own for that chip, or, for a typed or spoken answer that isn't a chip, one a small AI check asks for. After the last question the intake reading runs once and the lawyer readiness check is asked again next time. Returns the same state as POST .../questions.",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["questionId", "text", "via"],
          properties: {
            questionId: { type: "string", description: "`current.id` from the last state: a detail, or \"<detail>.followUp\"" },
            text: { type: "string", maxLength: CLIENT_STORY_CORRECTION_MAX_LENGTH },
            via: { type: "string", enum: ["tap", "typed", "voice"] },
          },
        }),
      },
      responses: {
        200: { description: "Where the questions are now" },
        400: err("Validation error"),
        403: err("CLIENT_AI_NOT_OPEN or CONSENT_REQUIRED"),
        404: err("Case not found"),
        409: err("QUESTIONS_NOT_STARTED, QUESTIONS_DONE, QUESTION_NOT_CURRENT (the screen is behind: read the state again), or TURN_IN_PROGRESS (a chat answer is being written)"),
        429: err("Too many answers in a short time"),
      },
    },
  },
  "/client/cases/{caseId}/questions/skip": {
    post: {
      tags: [TAG],
      summary: "\"I don't know, skip\": leave the question the client is on for the lawyer to ask",
      description: "Counts as done. A skipped follow-up leaves its detail answered as far as it went. `text` is what the client is shown saying, in their language (\"I'm not sure.\" when left out).",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["questionId"], properties: { questionId: { type: "string" }, text: { type: "string", maxLength: 100 } } }),
      },
      responses: {
        200: { description: "Where the questions are now" },
        403: err("CLIENT_AI_NOT_OPEN or CONSENT_REQUIRED"),
        404: err("Case not found"),
        409: err("QUESTIONS_NOT_STARTED, QUESTIONS_DONE, QUESTION_NOT_CURRENT or TURN_IN_PROGRESS"),
      },
    },
  },
  "/client/cases/{caseId}/story": {
    post: {
      tags: [TAG],
      summary: "\"Something's not right\": add the client's fix to their story and read the case again",
      description: "Kept as a chat message with no AI reply, like the story. The next chat turn starts a fresh AI session that sees it.",
      security,
      parameters: [caseId],
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["text"], properties: { text: { type: "string", maxLength: CLIENT_STORY_CORRECTION_MAX_LENGTH } } }),
      },
      responses: {
        202: { description: "The fix's message id and the intake (RUNNING once the reading is queued)", content: json({ type: "object", properties: { messageId: { type: "string" }, intake: caseIntake } }) },
        400: err("Validation error"),
        403: err("CLIENT_AI_NOT_OPEN or CONSENT_REQUIRED"),
        404: err("Case not found"),
        409: err("INTAKE_RUNNING: the story is still being read; TURN_IN_PROGRESS: a chat answer is still being written"),
        429: err("Too many stories in a short time"),
      },
    },
  },
};
