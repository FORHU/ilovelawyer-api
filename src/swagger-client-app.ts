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
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

export const clientAppPaths: Paths = {
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
          required: ["title", "area", "ukJurisdiction"],
          properties: {
            title: { type: "string", maxLength: 150 },
            area: { type: "string", enum: [...CLIENT_CASE_AREAS] },
            ukJurisdiction: { type: "string", enum: [...UK_JURISDICTIONS], nullable: true },
            where: { type: "string" },
            side: { type: "string", enum: ["CLAIMANT", "RESPONDENT"], nullable: true },
            others: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string", enum: [...CLIENT_PARTY_ROLES] } } } },
          },
        }),
      },
      responses: { 201: { description: "Created", content: json(clientCase) }, 400: err("Validation error"), 403: err("Not a client account") },
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
        202: { description: "Queued; the answer appears in GET messages" },
        403: err("CONSENT_REQUIRED (AI processing withdrawn) or FREE_CREDIT_SPENT"),
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
