import type { OAS3Definition } from "swagger-jsdoc";
import { CLIENT_CASE_AREAS, CLIENT_PARTY_ROLES } from "./constants/client-case.constants";
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

const clientDocument = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string", enum: ["PENDING", "READY", "FAILED"] },
    size: { type: "integer", nullable: true, description: "Bytes; null when the upload didn't say" },
    uploadedAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time", description: "Same as uploadedAt; kept for older apps" },
  },
};

const clientCase = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    area: { type: "string", enum: [...CLIENT_CASE_AREAS] },
    ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true, description: "Null: outside the UK" },
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
    usedAt: { type: "string", format: "date-time", nullable: true, description: "When a case payment created its case" },
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
      summary: "Price of a case, its credits, and the top-up packs (placeholders)",
      security,
      responses: {
        200: {
          description: "Pricing",
          content: json({
            type: "object",
            properties: {
              case: { type: "object", properties: { price: money, credits: { type: "integer" } } },
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
  "/client/payments/case/quote": {
    post: {
      tags: [TAG],
      summary: "What a new case costs, with a promo code applied if it can be",
      security,
      requestBody: { required: true, content: json({ type: "object", properties: { promoCode: { type: "string" } } }) },
      responses: {
        200: {
          description: "Quote",
          content: json({
            type: "object",
            properties: {
              price: money,
              discount: money,
              total: money,
              promo: {
                type: "object",
                nullable: true,
                properties: { code: { type: "string" }, applied: { type: "boolean" }, message: { type: "string" } },
              },
            },
          }),
        },
      },
    },
  },
  "/client/payments/case": {
    post: {
      tags: [TAG],
      summary: "Pay for a new case",
      description:
        "Returns a paymentId, which POST /client/cases then uses up once it has SUCCEEDED. One payment creates one case. With the dummy provider (CLIENT_PAYMENT_PROVIDER unset) it settles at once and `checkout` is null. With Stripe it starts PENDING and `checkout` opens Stripe's embedded payment form. No card details reach this API either way.",
      security,
      requestBody: { required: true, content: json({ type: "object", properties: { promoCode: { type: "string" }, testOutcome } }) },
      responses: {
        201: {
          description: "Paid (dummy) or started (Stripe)",
          content: json({
            type: "object",
            properties: { paymentId: { type: "string" }, status: paymentStatus, amount: money, credits: { type: "integer" }, checkout },
          }),
        },
        400: err("PROMO_NOT_APPLIED: the code doesn't apply (nothing charged)"),
        402: err("PAYMENT_DECLINED (dummy)"),
        502: err("PAYMENT_PROVIDER_ERROR: Stripe couldn't open the payment page (the payment is marked FAILED)"),
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
              usable: { type: "boolean", description: "A case payment that can still create its case" },
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
              practiceArea: {
                type: "object",
                nullable: true,
                properties: { value: { type: "string", enum: [...CLIENT_CASE_AREAS, "PERSONAL_INJURY"] }, confidence: { type: "number" } },
              },
              ukJurisdiction: { type: "string", nullable: true },
              blockedBy: { type: "string", enum: ["OUTSIDE_UK", "PERSONAL_INJURY"], nullable: true },
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
      description: "With the dummy the credits are added at once. With Stripe the payment starts PENDING with a `checkout`, and the credits are added when it settles (webhook, or GET /client/payments/{paymentId}).",
      security,
      parameters: [caseId],
      requestBody: { required: true, content: json({ type: "object", required: ["packId"], properties: { packId: { type: "string" }, testOutcome } }) },
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
        400: err("No such pack"),
        402: err("PAYMENT_DECLINED"),
        404: err("Not one of this client's cases"),
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
      security,
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["paymentId", "title", "area", "ukJurisdiction"],
          properties: {
            paymentId: { type: "string", description: "An unused case payment (POST /client/payments/case)" },
            title: { type: "string", maxLength: 150 },
            area: { type: "string", enum: [...CLIENT_CASE_AREAS] },
            ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true },
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
        402: err("PAYMENT_REQUIRED: no unused case payment of this client's with that id"),
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
            area: { type: "string", enum: [...CLIENT_CASE_AREAS] },
            ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true },
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
                    replyStatus: { type: "string", enum: ["PENDING", "DONE", "FAILED", "CANCELLED"], nullable: true },
                    documents: {
                      type: "array",
                      description: "The case documents sent with a user message. Always empty on the AI's",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string", enum: ["PENDING", "READY", "FAILED"] } },
                      },
                    },
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
        202: { description: "Queued; the answer appears in GET messages. Uses one chat credit" },
        402: err("OUT_OF_CREDITS: top up the case"),
        403: err("CONSENT_REQUIRED (AI processing withdrawn)"),
        404: err("Not one of this client's cases, or a documentId that isn't on this case"),
        409: err(
          "DOCUMENTS_NOT_READY: a document is still being read or couldn't be read; `message` names them and `documents` lists { id, name, status }. Otherwise a reply is already generating. Neither uses a credit",
        ),
      },
    },
  },
  "/client/cases/{caseId}/documents/presign": {
    post: {
      tags: [TAG],
      summary: "Step 1 of an upload: a URL to PUT the file to S3",
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
        content: json({ type: "object", required: ["key", "name"], properties: { key: { type: "string" }, name: { type: "string" }, contentType: { type: "string" }, fileSize: { type: "integer" } } }),
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
};
