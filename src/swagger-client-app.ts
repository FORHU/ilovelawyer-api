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

const clientCase = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    area: { type: "string", enum: [...CLIENT_CASE_AREAS] },
    ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true, description: "Null: outside the UK" },
    where: { type: "string", description: "Town or city, free text" },
    side: { type: "string", enum: ["CLAIMANT", "RESPONDENT"], nullable: true },
    others: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string", enum: [...CLIENT_PARTY_ROLES] } } },
    },
    documents: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string", enum: ["PENDING", "READY", "FAILED"] }, createdAt: { type: "string", format: "date-time" } },
      },
    },
    credits: { type: "integer", description: "Chat credits left; each message to the AI uses one" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
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
  "/client/cases/{caseId}": {
    get: {
      tags: [TAG],
      summary: "One of the client's cases",
      security,
      parameters: [caseId],
      responses: { 200: { description: "Case", content: json(clientCase) }, 404: err("Not one of this client's cases") },
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
      requestBody: { required: true, content: json({ type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 4000 } } }) },
      responses: {
        202: { description: "Queued; the answer appears in GET messages. Uses one chat credit" },
        402: err("OUT_OF_CREDITS: top up the case"),
        403: err("CONSENT_REQUIRED (AI processing withdrawn)"),
        404: err("Not one of this client's cases"),
        409: err("A reply is already generating"),
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
      responses: { 201: { description: "Added (status PENDING until it's read)" }, 404: err("Not one of this client's cases") },
    },
  },
};
