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
      summary: "Pay for a new case (DUMMY provider for now: nothing is charged)",
      description: "Returns a paymentId, which POST /client/cases then uses up. One payment creates one case. No card details are sent or stored.",
      security,
      requestBody: { required: true, content: json({ type: "object", properties: { promoCode: { type: "string" }, testOutcome } }) },
      responses: {
        201: {
          description: "Paid",
          content: json({ type: "object", properties: { paymentId: { type: "string" }, amount: money, credits: { type: "integer" } } }),
        },
        400: err("PROMO_NOT_APPLIED: the code doesn't apply (nothing charged)"),
        402: err("PAYMENT_DECLINED"),
      },
    },
  },
  "/client/cases/{caseId}/top-ups": {
    post: {
      tags: [TAG],
      summary: "Buy chat credits for a case (DUMMY provider for now)",
      security,
      parameters: [caseId],
      requestBody: { required: true, content: json({ type: "object", required: ["packId"], properties: { packId: { type: "string" }, testOutcome } }) },
      responses: {
        201: {
          description: "Credits added",
          content: json({ type: "object", properties: { credits: { type: "integer", description: "New balance" }, added: { type: "integer" }, amount: money } }),
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
