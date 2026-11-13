import type { OAS3Definition } from "swagger-jsdoc";
import { SUPPORT_ACTION_KEYS } from "./constants/support-actions.constants";
import { SUPPORT_CONTENT_PROBLEM_CODES } from "./constants/support-content.constants";

/**
 * The Support Chat API contract (EPIC ilovelawyer-client#120), merged into swagger.ts.
 * Content endpoints are built in ilovelawyer-api#639, actions in #640 and tickets in #641. A later lane's
 * endpoints can be declared here ahead of being built with `x-implemented: false`, so the client and admin
 * can mock them; flip the flag when the lane that builds one merges.
 *
 * Socket event, emitted to the client's `user:<id>` room by an admin reply (#641):
 *   `support:reply` { ticketId: string, messageId: string }
 * The client refetches GET /client/support/ticket on it and lights the Guide's unread dot.
 */

type Paths = NonNullable<OAS3Definition["paths"]>;
type Schemas = NonNullable<NonNullable<OAS3Definition["components"]>["schemas"]>;
type Tags = NonNullable<OAS3Definition["tags"]>;

const TAG = "Support Chat";
const ADMIN_TAG = "Support Chat (admin)";
const security = [{ bearerAuth: [] }];
const json = (schema: object) => ({ "application/json": { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const err = (description: string) => ({ description, content: json(ref("Error")) });
const built = (issue: string) => ({ "x-implemented": true, "x-issue": issue });

const version = { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } };
const ticketId = { name: "id", in: "path", required: true, schema: { type: "string" } };

export const supportTags: Tags = [
  { name: TAG, description: "The client app's automated, Messenger-style help desk. Menu-driven, no AI, free, never reads case contents. Real-time: socket event `support:reply` { ticketId, messageId } to room `user:<id>` when an admin replies." },
  { name: ADMIN_TAG, description: "Platform admins edit the Support Chat's content and answer its tickets. Admin accounts only (403 otherwise)." },
];

const target = {
  oneOf: [
    { type: "object", required: ["kind", "stepId"], properties: { kind: { type: "string", enum: ["STEP"] }, stepId: { type: "string" } } },
    { type: "object", required: ["kind", "flowId"], properties: { kind: { type: "string", enum: ["FLOW"] }, flowId: { type: "string" } } },
    { type: "object", required: ["kind", "href"], properties: { kind: { type: "string", enum: ["LINK"] }, href: { type: "string", description: "https://, mailto: or an app path starting with /" }, label: { type: "string" } } },
    { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["TALK_TO_PERSON"] } } },
    { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["END"] } } },
  ],
};

const step = {
  oneOf: [
    { type: "object", required: ["id", "type", "text"], properties: { id: { type: "string" }, type: { type: "string", enum: ["MESSAGE"] }, text: { type: "string" }, next: ref("SupportTarget") } },
    {
      type: "object",
      required: ["id", "type", "style", "options"],
      properties: {
        id: { type: "string" },
        type: { type: "string", enum: ["CHOICES"] },
        text: { type: "string" },
        style: { type: "string", enum: ["BUTTONS", "QUICK_REPLIES"] },
        options: { type: "array", items: { type: "object", required: ["label", "target"], properties: { label: { type: "string" }, target: ref("SupportTarget") } } },
      },
    },
    {
      type: "object",
      required: ["id", "type", "actionKey", "onSuccess", "onFailure"],
      properties: { id: { type: "string" }, type: { type: "string", enum: ["ACTION"] }, actionKey: { type: "string", enum: [...SUPPORT_ACTION_KEYS] }, onSuccess: ref("SupportTarget"), onFailure: ref("SupportTarget") },
    },
    { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { type: "string", enum: ["DID_THAT_HELP"] } }, description: "Yes ends the flow. The first No offers relatedFlowIds. A second No offers Talk to a person." },
  ],
};

const flow = {
  type: "object",
  required: ["id", "title", "audience", "triggers", "relatedFlowIds", "startStepId", "steps"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    audience: { type: "string", enum: ["SIGNED_IN", "SIGNED_OUT", "BOTH"] },
    triggers: { type: "array", items: { type: "string" }, description: "Words and phrases the client matches typed text against" },
    relatedFlowIds: { type: "array", items: { type: "string" } },
    startStepId: { type: "string" },
    steps: { type: "object", additionalProperties: ref("SupportStep"), description: "By step id" },
  },
};

const menuCard = {
  type: "object",
  required: ["id", "title", "flowId", "enabled"],
  properties: { id: { type: "string" }, title: { type: "string" }, subtitle: { type: "string" }, flowId: { type: "string" }, enabled: { type: "boolean" } },
};

const settings = {
  type: "object",
  required: ["assistantName", "avatarUrl", "greeting", "responseTimeLine"],
  properties: {
    assistantName: { type: "string" },
    avatarUrl: { type: "string", nullable: true },
    greeting: { type: "string", description: "May contain {firstName}. The only placeholder allowed." },
    responseTimeLine: { type: "string" },
  },
};

const actionMeta = {
  type: "object",
  required: ["key", "label"],
  properties: {
    key: { type: "string", enum: [...SUPPORT_ACTION_KEYS] },
    label: { type: "string" },
    safetyCopy: { type: "array", items: { type: "string" }, description: "Fixed text the chat shows before running the action. Owned by the action; not editable." },
  },
};

export const supportSchemas: Schemas = {
  SupportTarget: target,
  SupportStep: step,
  SupportFlow: flow,
  SupportMenuCard: menuCard,
  SupportSettings: settings,
  SupportContent: {
    type: "object",
    required: ["schemaVersion", "settings", "menus", "flows"],
    description: "The Support Chat's whole content: one JSON document the client and admin share (src/types/support-content.ts).",
    properties: {
      schemaVersion: { type: "integer", enum: [1] },
      settings: ref("SupportSettings"),
      menus: { type: "object", properties: { SIGNED_IN: { type: "array", items: ref("SupportMenuCard") }, SIGNED_OUT: { type: "array", items: ref("SupportMenuCard") } } },
      flows: { type: "object", additionalProperties: ref("SupportFlow"), description: "By flow id" },
    },
  },
  SupportActionMeta: actionMeta,
  SupportActionDef: {
    type: "object",
    properties: {
      key: { type: "string", enum: [...SUPPORT_ACTION_KEYS] },
      label: { type: "string" },
      audience: { type: "string", enum: ["IN", "OUT", "BOTH"] },
      readsAccount: { type: "boolean", description: "Reads or changes the signed-in client's own account. Never allowed in a signed-out flow." },
      safetyCopy: { type: "array", items: { type: "string" } },
    },
  },
  PublishedSupportContent: {
    type: "object",
    properties: {
      version: { type: "integer" },
      publishedAt: { type: "string", format: "date-time" },
      settings: ref("SupportSettings"),
      menu: { type: "array", items: ref("SupportMenuCard"), description: "Enabled cards only, in order" },
      flows: { type: "object", additionalProperties: ref("SupportFlow"), description: "Only the flows available to this audience" },
      actions: { type: "array", items: ref("SupportActionMeta"), description: "The actions this audience may run" },
    },
  },
  SupportContentProblem: {
    type: "object",
    properties: {
      path: { type: "string", example: "flows.refund.steps.start.options[0].target" },
      code: {
        type: "string",
        enum: [...SUPPORT_CONTENT_PROBLEM_CODES],
      },
      message: { type: "string" },
    },
  },
  SupportDraft: {
    type: "object",
    properties: {
      content: ref("SupportContent"),
      updatedAt: { type: "string", format: "date-time", description: "Send back as expectedUpdatedAt when saving" },
      updatedBy: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string", nullable: true } } },
      basedOnVersion: { type: "integer", nullable: true },
      currentVersion: { type: "integer" },
      hasUnpublishedChanges: { type: "boolean" },
    },
  },
  SupportVersionSummary: {
    type: "object",
    properties: {
      version: { type: "integer" },
      publishedAt: { type: "string", format: "date-time" },
      publishedBy: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string", nullable: true } } },
      rolledBackFromVersion: { type: "integer", nullable: true },
      isCurrent: { type: "boolean" },
    },
  },
  SupportDeletionCheck: {
    type: "object",
    properties: {
      blocking: {
        type: "array",
        description: "Lawyer requests that stop the account being deleted. Empty means the client can go on.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            caseId: { type: "string" },
            caseTitle: { type: "string" },
            status: { type: "string", description: "As the app shows it (CLAIMED and QUOTED are read off a routed request's claims)" },
            action: {
              type: "string",
              enum: ["WITHDRAW", "END", "REVIEW"],
              description: "WITHDRAW: POST /client/lawyer-requests/{id}/withdraw. END: POST /client/lawyer-requests/{id}/end. REVIEW: the quote is accepted and awaiting payment; open the request.",
            },
          },
        },
      },
      hasPassword: { type: "boolean", description: "False for a Google account: DELETE /users/me and the export take no password" },
      creditsRemaining: { type: "integer", description: "Chat Credits across the client's active cases, which deletion loses without a refund" },
    },
  },
  SupportActionResult: {
    description: "The result of a dispatched Support Action. Its shape depends on the key.",
    oneOf: [
      {
        type: "object",
        title: "CHECK_PAYMENT",
        properties: {
          payments: {
            type: "array",
            description: "The last 5 payments from the last 30 days, newest first",
            items: {
              type: "object",
              properties: {
                paymentId: { type: "string" },
                kind: { type: "string", enum: ["CASE", "TOP_UP"] },
                status: { type: "string", enum: ["PENDING", "SUCCEEDED", "FAILED"] },
                amount: { type: "object", properties: { amountMinor: { type: "integer" }, currency: { type: "string" } } },
                credits: { type: "integer" },
                caseId: { type: "string", nullable: true },
                caseTitle: { type: "string", nullable: true },
                createdAt: { type: "string", format: "date-time" },
                failureReason: { type: "string", nullable: true },
              },
            },
          },
        },
      },
      {
        type: "object",
        title: "SHOW_CREDITS",
        properties: { cases: { type: "array", items: { type: "object", properties: { caseId: { type: "string" }, title: { type: "string" }, credits: { type: "integer" } } } } },
      },
      {
        type: "object",
        title: "SHOW_LAWYER_REQUESTS",
        properties: {
          requests: {
            type: "array",
            description: "The latest 10, newest first",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                caseId: { type: "string" },
                caseTitle: { type: "string" },
                status: { type: "string" },
                expiresAt: { type: "string", format: "date-time", nullable: true, description: "When a routed request lapses (or the client must pick a quote by); null once it isn't waiting" },
                lawyerName: { type: "string", nullable: true },
              },
            },
          },
        },
      },
      {
        type: "object",
        title: "SEND_PASSWORD_RESET",
        properties: { sent: { type: "boolean" }, reason: { type: "string", enum: ["GOOGLE_ACCOUNT"], description: "Present when nothing was sent because the account signs in with Google (a note saying so is emailed instead)" } },
      },
    ],
  },
  SupportTicketMessage: {
    type: "object",
    properties: {
      id: { type: "string" },
      author: { type: "string", enum: ["CLIENT", "ADMIN", "SYSTEM"] },
      body: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  SupportTicketContext: {
    type: "object",
    description: "Built by the API, never case contents (documents, AI chat, party names).",
    properties: {
      name: { type: "string", nullable: true },
      email: { type: "string" },
      flowPath: { type: "array", items: { type: "string" } },
      page: { type: "string", nullable: true },
      caseId: { type: "string", nullable: true },
      clientRequestId: { type: "string", nullable: true },
      clientRequestStatus: { type: "string", nullable: true },
    },
  },
  SupportTicketThread: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["OPEN", "ANSWERED", "RESOLVED"] },
      messages: { type: "array", items: ref("SupportTicketMessage") },
      unreadCount: { type: "integer", description: "Admin replies the client hasn't seen. Drives the Guide's red dot." },
    },
  },
  SupportTicketRow: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["OPEN", "ANSWERED", "RESOLVED"] },
      source: { type: "string", enum: ["SIGNED_IN", "SIGNED_OUT"] },
      userId: { type: "string", nullable: true, description: "The client account: set for a signed-in ticket, and for a signed-out one whose email matched an account" },
      email: { type: "string" },
      name: { type: "string", nullable: true },
      flowId: { type: "string", nullable: true, description: "The last Support Flow the client was in" },
      firstMessage: { type: "string", description: "The first 140 characters" },
      createdAt: { type: "string", format: "date-time" },
      lastMessageAt: { type: "string", format: "date-time" },
      ageHours: { type: "integer", description: "Hours since the ticket was opened" },
      overdue: { type: "boolean", description: "OPEN for more than 24 hours since the client last wrote" },
    },
  },
  SupportTicketDetail: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["OPEN", "ANSWERED", "RESOLVED"] },
      source: { type: "string", enum: ["SIGNED_IN", "SIGNED_OUT"] },
      userId: { type: "string", nullable: true },
      email: { type: "string" },
      name: { type: "string", nullable: true },
      flowId: { type: "string", nullable: true },
      context: ref("SupportTicketContext"),
      createdAt: { type: "string", format: "date-time" },
      lastMessageAt: { type: "string", format: "date-time" },
      answeredAt: { type: "string", format: "date-time", nullable: true },
      resolvedAt: { type: "string", format: "date-time", nullable: true },
      clientReadAt: { type: "string", format: "date-time", nullable: true },
      overdue: { type: "boolean" },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            author: { type: "string", enum: ["CLIENT", "ADMIN", "SYSTEM"] },
            authorName: { type: "string" },
            body: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
  },
  SupportReport: {
    type: "object",
    properties: {
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time", description: "Exclusive" },
      totals: {
        type: "object",
        properties: {
          started: { type: "integer" },
          helpedYes: { type: "integer" },
          helpedNo: { type: "integer" },
          escalated: { type: "integer" },
          unmatched: { type: "integer" },
          escalationRate: { type: "number", nullable: true, description: "escalated / started; null if nothing started" },
        },
      },
      flows: {
        type: "array",
        description: "Worst first: most escalations plus No answers",
        items: {
          type: "object",
          properties: {
            flowId: { type: "string" },
            flowTitle: { type: "string", nullable: true, description: "From the published content; null if the flow has since been removed" },
            started: { type: "integer" },
            helpedYes: { type: "integer" },
            helpedNo: { type: "integer" },
            escalated: { type: "integer" },
            helpedYesRate: { type: "number", nullable: true, description: "Yes / (Yes + No)" },
            helpedNoRate: { type: "number", nullable: true },
            escalationRate: { type: "number", nullable: true },
          },
        },
      },
      unmatchedPhrases: {
        type: "array",
        description: "The 20 most typed phrases that matched no flow, with emails, phone numbers and postcodes removed",
        items: { type: "object", properties: { text: { type: "string" }, count: { type: "integer" } } },
      },
    },
  },
  SupportOutcomes: {
    type: "object",
    required: ["events"],
    properties: {
      events: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["FLOW_STARTED", "HELPED_YES", "HELPED_NO", "ESCALATED", "UNMATCHED"] },
            flowId: { type: "string", pattern: "^[\\w-]+$" },
            contentVersion: { type: "integer", description: "The published version the client was reading" },
            text: { type: "string", description: "UNMATCHED only: what the client typed" },
          },
        },
      },
    },
  },
};

const problemResponse = err("Invalid. `details.problems` lists SupportContentProblem objects (code SUPPORT_CONTENT_INVALID)");

const adminOnly = { 401: err("No session"), 403: err("Not an admin") };

export const supportPaths: Paths = {
  "/client/support/content": {
    get: {
      tags: [TAG],
      summary: "The published Support Chat for a signed-in client",
      description: "Client accounts only. The enabled signed-in menu cards, the flows available to signed-in clients, and the actions they may run. Never returns a draft.",
      security,
      ...built("ilovelawyer-api#639"),
      responses: { 200: { description: "Published content", content: json(ref("PublishedSupportContent")) }, 401: err("No session"), 403: err("Not a client account (CLIENT_ACCOUNT_ONLY)") },
    },
  },
  "/support/content": {
    get: {
      tags: [TAG],
      summary: "The published Support Chat for a visitor who isn't signed in",
      description: "No session. Cacheable (Cache-Control: public, max-age=300) and rate-limited per IP. Contains no account-reading actions.",
      ...built("ilovelawyer-api#639"),
      responses: { 200: { description: "Published content", content: json(ref("PublishedSupportContent")) }, 429: err("Rate limited") },
    },
  },
  "/admin/support/content/draft": {
    get: {
      tags: [ADMIN_TAG],
      summary: "The draft the admin is editing",
      security,
      ...built("ilovelawyer-api#639"),
      responses: { 200: { description: "The draft", content: json(ref("SupportDraft")) }, ...adminOnly },
    },
    put: {
      tags: [ADMIN_TAG],
      summary: "Save the draft",
      description: "Clients don't see it until Publish. 409 DRAFT_CONFLICT when the draft changed since `expectedUpdatedAt`. Audited as admin.support_content.draft_updated.",
      security,
      ...built("ilovelawyer-api#639"),
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["content", "expectedUpdatedAt"], properties: { content: ref("SupportContent"), expectedUpdatedAt: { type: "string", format: "date-time" } } }),
      },
      responses: { 200: { description: "The saved draft", content: json(ref("SupportDraft")) }, 400: err("Wrong shape (INVALID_SUPPORT_CONTENT)"), 409: err("DRAFT_CONFLICT"), ...adminOnly },
    },
  },
  "/admin/support/content/draft/validate": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Check the draft for problems without publishing",
      security,
      ...built("ilovelawyer-api#639"),
      responses: {
        200: { description: "Valid, or a list of problems", content: json({ type: "object", properties: { valid: { type: "boolean" }, problems: { type: "array", items: ref("SupportContentProblem") } } }) },
        ...adminOnly,
      },
    },
  },
  "/admin/support/content/publish": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Publish the draft as the next version",
      description: "Refuses invalid content (422 SUPPORT_CONTENT_INVALID) an unchanged draft (409 NO_CHANGES), and a draft saved while it was being published (409 DRAFT_CONFLICT, nothing published). Audited as admin.support_content.published.",
      security,
      ...built("ilovelawyer-api#639"),
      responses: {
        201: { description: "Published", content: json({ type: "object", properties: { version: { type: "integer" }, publishedAt: { type: "string", format: "date-time" } } }) },
        409: err("NO_CHANGES or PUBLISH_CONFLICT"),
        422: problemResponse,
        ...adminOnly,
      },
    },
  },
  "/admin/support/content/versions": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Published versions, newest first",
      security,
      ...built("ilovelawyer-api#639"),
      responses: { 200: { description: "Versions", content: json({ type: "array", items: ref("SupportVersionSummary") }) }, ...adminOnly },
    },
  },
  "/admin/support/content/versions/{version}": {
    get: {
      tags: [ADMIN_TAG],
      summary: "One published version, with its content",
      security,
      ...built("ilovelawyer-api#639"),
      parameters: [version],
      responses: {
        200: { description: "The version", content: json({ type: "object", properties: { version: { type: "integer" }, publishedAt: { type: "string", format: "date-time" }, publishedBy: { type: "object", nullable: true }, rolledBackFromVersion: { type: "integer", nullable: true }, content: ref("SupportContent") } }) },
        404: err("SUPPORT_VERSION_NOT_FOUND"),
        ...adminOnly,
      },
    },
  },
  "/admin/support/content/versions/{version}/rollback": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Roll back to an earlier version",
      description: "Publishes an exact copy of that version as the newest one and points the draft at it, replacing any unpublished draft edits (the editor should confirm first). Audited as admin.support_content.rolled_back.",
      security,
      ...built("ilovelawyer-api#639"),
      parameters: [version],
      responses: {
        201: { description: "The new version", content: json({ type: "object", properties: { version: { type: "integer" }, publishedAt: { type: "string", format: "date-time" }, rolledBackFromVersion: { type: "integer" } } }) },
        404: err("SUPPORT_VERSION_NOT_FOUND"),
        409: err("ALREADY_CURRENT"),
        ...adminOnly,
      },
    },
  },
  "/admin/support/actions": {
    get: {
      tags: [ADMIN_TAG],
      summary: "The fixed Support Action catalog, for the editor's action picker",
      description: "Admins place an action in a flow by key. They can't change what it does or its safety copy.",
      security,
      ...built("ilovelawyer-api#639"),
      responses: { 200: { description: "Actions", content: json({ type: "array", items: ref("SupportActionDef") }) }, ...adminOnly },
    },
  },

  // ── Support Actions (ilovelawyer-api#640) ──────────────────────────────────────────────────────
  "/client/support/actions/deletion-check": {
    get: {
      tags: [TAG],
      summary: "What blocks deleting the account",
      description:
        "Run this before `DELETE /users/me`. Client requests that are REQUESTED, ROUTED, CLAIMED, QUOTED, CONFIRMED or ENGAGED block deletion (`DELETE /users/me` answers 409 OPEN_LAWYER_REQUESTS with the same `requests`). Link each one: WITHDRAW → POST /client/lawyer-requests/{id}/withdraw, END → POST /client/lawyer-requests/{id}/end, REVIEW → open the request (the quote is accepted and waiting on payment, so there is nothing to withdraw or end yet; pay it, then end it, or let it lapse). CLOSED, EXPIRED and WITHDRAWN don't block.",
      security,
      ...built("ilovelawyer-api#640"),
      responses: {
        200: { description: "Blocking requests, whether a password is needed, and credits that would be lost", content: json(ref("SupportDeletionCheck")) },
        401: err("No session"),
        403: err("Not a client account (CLIENT_ACCOUNT_ONLY)"),
      },
    },
  },
  "/client/support/actions/{key}": {
    post: {
      tags: [TAG],
      summary: "Run a Support Action for the signed-in client",
      description:
        "CHECK_PAYMENT, SHOW_CREDITS, SHOW_LAWYER_REQUESTS and SEND_PASSWORD_RESET. The result's shape is fixed per key (SupportActionResult). CHECK_PAYMENT re-checks a PENDING Stripe payment with Stripe and settles it if it has moved on. EXPORT_MY_DATA, DELETE_MY_ACCOUNT and OPEN_TICKET are client-direct: 400 ACTION_NOT_DISPATCHABLE. Call POST /users/me/export, DELETE /users/me (after the deletion check) and POST /client/support/ticket/messages. Any other key is 404 UNKNOWN_ACTION.",
      security,
      ...built("ilovelawyer-api#640"),
      parameters: [{ name: "key", in: "path", required: true, schema: { type: "string", enum: ["CHECK_PAYMENT", "SHOW_CREDITS", "SHOW_LAWYER_REQUESTS", "SEND_PASSWORD_RESET"] } }],
      responses: {
        200: { description: "The action's result", content: json(ref("SupportActionResult")) },
        400: err("ACTION_NOT_DISPATCHABLE"),
        401: err("No session"),
        403: err("Not a client account (CLIENT_ACCOUNT_ONLY)"),
        404: err("UNKNOWN_ACTION"),
      },
    },
  },
  "/support/actions/{key}": {
    post: {
      tags: [TAG],
      summary: "Run a Support Action when signed out",
      description:
        "SEND_PASSWORD_RESET (a reset link) or RESEND_CODE (a new sign-in code) for the email given. Always answers 200 { ok: true }, whether or not the email has an account, and without waiting for the email, so neither the answer nor its timing says which. Rate-limited per IP and per email (429 for any address). Any other key is 404.",
      ...built("ilovelawyer-api#640"),
      parameters: [{ name: "key", in: "path", required: true, schema: { type: "string", enum: ["SEND_PASSWORD_RESET", "RESEND_CODE"] } }],
      requestBody: { required: true, content: json({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }) },
      responses: {
        200: { description: "Always { ok: true }", content: json({ type: "object", properties: { ok: { type: "boolean", enum: [true] } } }) },
        400: err("Not an email address"),
        404: err("UNKNOWN_ACTION"),
        429: err("Rate limited"),
      },
    },
  },

  // ── Support Tickets (ilovelawyer-api#641) ──────────────────────────────────────────────────────
  "/client/support/ticket": {
    get: {
      tags: [TAG],
      summary: "The client's Support Ticket thread",
      description: "The open ticket, else the latest one. Null if the client never wrote. The Support Chat is one continuous conversation: every message the client sends joins the open ticket.",
      security,
      ...built("ilovelawyer-api#641"),
      responses: { 200: { description: "The thread, or null", content: json({ nullable: true, ...ref("SupportTicketThread") }) }, 401: err("No session"), 403: err("Not a client account (CLIENT_ACCOUNT_ONLY)") },
    },
  },
  "/client/support/ticket/messages": {
    post: {
      tags: [TAG],
      summary: "Send a message to the team (this is also the OPEN_TICKET action)",
      description:
        "Opens a ticket if the client has none open; otherwise the message joins it. A message to an ANSWERED ticket makes it OPEN again. A resolved ticket stays resolved: the next message opens a new one. Text only, 1 to 4000 characters, no attachments. `context` says where the client was: the API keeps `caseId` and `clientRequestId` only if they are the client's, adds the request's status and the client's name and email, and keeps the page as a path without query or hash. Never case documents, AI chat, party names or a case title. 60 per 10 minutes per client.",
      security,
      ...built("ilovelawyer-api#641"),
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", maxLength: 4000 },
            context: { type: "object", properties: { flowPath: { type: "array", maxItems: 12, items: { type: "string", pattern: "^[\\w-]+$" } }, page: { type: "string", maxLength: 200 }, caseId: { type: "string" }, clientRequestId: { type: "string" } } },
          },
        }),
      },
      responses: { 201: { description: "The thread", content: json(ref("SupportTicketThread")) }, 400: err("Empty, too long, or an unknown field"), 429: err("Rate limited") },
    },
  },
  "/client/support/ticket/read": {
    post: {
      tags: [TAG],
      summary: "Mark the thread read",
      description: "Call when the Support Chat opens. Clears the Guide's red dot (`unreadCount` goes to 0).",
      security,
      ...built("ilovelawyer-api#641"),
      responses: { 204: { description: "Marked" } },
    },
  },
  "/client/support/outcomes": {
    post: {
      tags: [TAG],
      summary: "Report flow outcomes",
      description:
        "Up to 20 events per call: FLOW_STARTED, HELPED_YES, HELPED_NO, ESCALATED, UNMATCHED. `text` is only kept for UNMATCHED (what the client typed that matched no flow), with emails, phone numbers and postcodes removed and lower-cased. No user is stored. Not a transcript.",
      security,
      ...built("ilovelawyer-api#641"),
      requestBody: { required: true, content: json(ref("SupportOutcomes")) },
      responses: { 204: { description: "Recorded" }, 400: err("Empty, more than 20, an unknown kind or a bad flow id") },
    },
  },
  "/support/tickets": {
    post: {
      tags: [TAG],
      summary: "Open a Support Ticket when signed out",
      description:
        "Needs a Cloudflare Turnstile token (`turnstileToken`): 400 CAPTCHA_FAILED without a valid one. 30 per IP and 3 per email address per 15 minutes (429, the same for any address; a failed captcha doesn't count against the address). Always answers 202 { ok: true }, whether or not the email has an account: a matching client account is linked for the admin, but never joins that client's own thread. The team replies by email only.",
      ...built("ilovelawyer-api#641"),
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["email", "message", "turnstileToken"],
          properties: {
            email: { type: "string", format: "email" },
            message: { type: "string", maxLength: 4000 },
            turnstileToken: { type: "string" },
            context: { type: "object", properties: { flowPath: { type: "array", items: { type: "string" } }, page: { type: "string" } } },
          },
        }),
      },
      responses: { 202: { description: "Accepted", content: json({ type: "object", properties: { ok: { type: "boolean", enum: [true] } } }) }, 400: err("CAPTCHA_FAILED, or a bad address or message"), 429: err("Rate limited") },
    },
  },
  "/support/outcomes": {
    post: {
      tags: [TAG],
      summary: "Report flow outcomes when signed out",
      description: "As POST /client/support/outcomes. Rate-limited per IP.",
      ...built("ilovelawyer-api#641"),
      requestBody: { required: true, content: json(ref("SupportOutcomes")) },
      responses: { 204: { description: "Recorded" }, 400: err("Invalid"), 429: err("Rate limited") },
    },
  },
  "/admin/support/tickets": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Support Tickets inbox",
      description: "Filter by status, search by email or name, and sort by age (oldest first) or last message (newest first, the default). 25 a page.",
      security,
      ...built("ilovelawyer-api#641"),
      parameters: [
        { name: "status", in: "query", schema: { type: "string", enum: ["OPEN", "ANSWERED", "RESOLVED"] } },
        { name: "q", in: "query", schema: { type: "string" }, description: "Email or name contains" },
        { name: "sort", in: "query", schema: { type: "string", enum: ["age", "updated"], default: "updated" } },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
      ],
      responses: {
        200: { description: "A page of tickets", content: json({ type: "object", properties: { total: { type: "integer" }, page: { type: "integer" }, pageSize: { type: "integer" }, data: { type: "array", items: ref("SupportTicketRow") } } }) },
        ...adminOnly,
      },
    },
  },
  "/admin/support/tickets/{id}": {
    get: {
      tags: [ADMIN_TAG],
      summary: "One ticket: the thread and the context the bot attached",
      security,
      ...built("ilovelawyer-api#641"),
      parameters: [ticketId],
      responses: { 200: { description: "The ticket", content: json(ref("SupportTicketDetail")) }, 404: err("TICKET_NOT_FOUND"), ...adminOnly },
    },
  },
  "/admin/support/tickets/{id}/replies": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Reply to a ticket",
      description:
        "Moves it to ANSWERED. A signed-in client gets the `support:reply` socket event ({ ticketId, messageId } to room `user:<id>`) and an email, \"You have a reply from ilovelawyer support\", with a link that opens the Support Chat (`/?support=open`). The email doesn't carry the reply. A visitor gets the reply in the email, and no socket event. 409 TICKET_RESOLVED on a resolved ticket. Audited as admin.support_ticket.replied (never the text).",
      security,
      ...built("ilovelawyer-api#641"),
      parameters: [ticketId],
      requestBody: { required: true, content: json({ type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 4000 } } }) },
      responses: {
        201: { description: "The reply", content: json({ type: "object", properties: { id: { type: "string" }, author: { type: "string", enum: ["ADMIN"] }, body: { type: "string" }, createdAt: { type: "string", format: "date-time" }, ticketStatus: { type: "string", enum: ["ANSWERED"] } } }) },
        404: err("TICKET_NOT_FOUND"),
        409: err("TICKET_RESOLVED"),
        ...adminOnly,
      },
    },
  },
  "/admin/support/tickets/{id}/resolve": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Resolve a ticket",
      description: "Frees a signed-in client to open another. A client's next message opens a new ticket. Audited.",
      security,
      ...built("ilovelawyer-api#641"),
      parameters: [ticketId],
      responses: { 200: { description: "The ticket", content: json(ref("SupportTicketDetail")) }, 404: err("TICKET_NOT_FOUND"), 409: err("TICKET_ALREADY_RESOLVED"), ...adminOnly },
    },
  },
  "/admin/support/tickets/{id}/reopen": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Reopen a resolved ticket",
      description: "409 CLIENT_HAS_OPEN_TICKET if the client has since opened another (reply there), 409 TICKET_NOT_RESOLVED if it isn't resolved. Audited.",
      security,
      ...built("ilovelawyer-api#641"),
      parameters: [ticketId],
      responses: { 200: { description: "The ticket", content: json(ref("SupportTicketDetail")) }, 404: err("TICKET_NOT_FOUND"), 409: err("CLIENT_HAS_OPEN_TICKET or TICKET_NOT_RESOLVED"), ...adminOnly },
    },
  },
  "/admin/support/report": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Support outcome report",
      description: "For a date range of at most 366 days (`to` exclusive): per flow started, Yes and No answers and escalations (worst first); the overall escalation rate; and the most typed phrases that matched no flow.",
      security,
      ...built("ilovelawyer-api#641"),
      parameters: [
        { name: "from", in: "query", required: true, schema: { type: "string", format: "date-time" } },
        { name: "to", in: "query", required: true, schema: { type: "string", format: "date-time" }, description: "Exclusive; after `from`" },
      ],
      responses: { 200: { description: "The report", content: json(ref("SupportReport")) }, 400: err("INVALID_RANGE or missing dates"), ...adminOnly },
    },
  },
};
