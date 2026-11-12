import type { OAS3Definition } from "swagger-jsdoc";
import { SUPPORT_ACTION_KEYS } from "./constants/support-actions.constants";

/**
 * The Support Chat API contract (EPIC ilovelawyer-client#120), merged into swagger.ts.
 * Content endpoints are built in ilovelawyer-api#639. Actions (#640) and tickets (#641) are
 * declared here too, with `x-implemented: false` until they land, so the client and admin can mock
 * them. Flip the flag when the lane that builds one merges.
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
const planned = (issue: string) => ({ "x-implemented": false, "x-issue": issue });
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
        enum: ["UNKNOWN_PLACEHOLDER", "EMPTY_MENU", "DUPLICATE_ID", "MENU_FLOW_MISSING", "MENU_FLOW_AUDIENCE", "ID_MISMATCH", "TARGET_FLOW_MISSING", "FLOW_AUDIENCE_MISMATCH", "START_STEP_MISSING", "UNKNOWN_ACTION", "ACTION_AUDIENCE_MISMATCH", "TARGET_STEP_MISSING", "INVALID_LINK", "STEP_UNREACHABLE"],
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
      caseTitle: { type: "string", nullable: true },
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
      description: "Refuses invalid content (422 SUPPORT_CONTENT_INVALID) and an unchanged draft (409 NO_CHANGES). Audited as admin.support_content.published.",
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
      description: "Publishes an exact copy of that version as the newest one and points the draft at it. Audited as admin.support_content.rolled_back.",
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

  // ── Planned: Support Tickets (ilovelawyer-api#641) ─────────────────────────────────────────────
  "/client/support/ticket": {
    get: {
      tags: [TAG],
      summary: "The client's Support Ticket thread",
      security,
      ...planned("ilovelawyer-api#641"),
      responses: { 200: { description: "The open (or latest) thread, or null", content: json({ nullable: true, ...ref("SupportTicketThread") }) } },
    },
  },
  "/client/support/ticket/messages": {
    post: {
      tags: [TAG],
      summary: "Send a message to the team (also opens a ticket)",
      description: "One open ticket per client: a new message joins it. A reply to an ANSWERED ticket moves it back to OPEN. Text only, 4000 characters at most. `context` carries the flow path and page; the API adds the rest and verifies case and request ids belong to the client.",
      security,
      ...planned("ilovelawyer-api#641"),
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 4000 }, context: { type: "object", properties: { flowPath: { type: "array", items: { type: "string" } }, page: { type: "string" }, caseId: { type: "string" }, clientRequestId: { type: "string" } } } } }),
      },
      responses: { 201: { description: "The thread", content: json(ref("SupportTicketThread")) } },
    },
  },
  "/client/support/ticket/read": {
    post: {
      tags: [TAG],
      summary: "Mark the thread read",
      security,
      ...planned("ilovelawyer-api#641"),
      responses: { 204: { description: "Marked" } },
    },
  },
  "/client/support/outcomes": {
    post: {
      tags: [TAG],
      summary: "Report flow outcomes",
      description: "Up to 20 per call: FLOW_STARTED, HELPED_YES, HELPED_NO, ESCALATED, UNMATCHED (with the typed text, which the API redacts of emails and phone numbers).",
      security,
      ...planned("ilovelawyer-api#641"),
      requestBody: {
        required: true,
        content: json({
          type: "object",
          required: ["events"],
          properties: { events: { type: "array", maxItems: 20, items: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["FLOW_STARTED", "HELPED_YES", "HELPED_NO", "ESCALATED", "UNMATCHED"] }, flowId: { type: "string" }, contentVersion: { type: "integer" }, text: { type: "string" } } } } },
        }),
      },
      responses: { 204: { description: "Recorded" } },
    },
  },
  "/support/tickets": {
    post: {
      tags: [TAG],
      summary: "Open a Support Ticket when signed out",
      description: "Needs a Cloudflare Turnstile token. Rate-limited per IP and per email. Always answers 202, whether or not the email has an account (a matching account is linked silently). Replies go by email only.",
      ...planned("ilovelawyer-api#641"),
      requestBody: {
        required: true,
        content: json({ type: "object", required: ["email", "message", "turnstileToken"], properties: { email: { type: "string" }, message: { type: "string", maxLength: 4000 }, turnstileToken: { type: "string" }, context: { type: "object", properties: { flowPath: { type: "array", items: { type: "string" } }, page: { type: "string" } } } } }),
      },
      responses: { 202: { description: "Accepted", content: json({ type: "object", properties: { ok: { type: "boolean" } } }) }, 400: err("Captcha failed"), 429: err("Rate limited") },
    },
  },
  "/support/outcomes": {
    post: {
      tags: [TAG],
      summary: "Report flow outcomes when signed out",
      description: "As POST /client/support/outcomes, with no user attached. Rate-limited.",
      ...planned("ilovelawyer-api#641"),
      responses: { 204: { description: "Recorded" }, 429: err("Rate limited") },
    },
  },
  "/admin/support/tickets": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Support Tickets inbox",
      description: "Filter by status, search by email, sort by age or last update. Each row includes firstMessage, flowId, ageHours and overdue (OPEN for more than 24h).",
      security,
      ...planned("ilovelawyer-api#641"),
      parameters: [
        { name: "status", in: "query", schema: { type: "string", enum: ["OPEN", "ANSWERED", "RESOLVED"] } },
        { name: "q", in: "query", schema: { type: "string" }, description: "Email search" },
        { name: "sort", in: "query", schema: { type: "string", enum: ["age", "updated"] } },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
      ],
      responses: { 200: { description: "A page of tickets" }, ...adminOnly },
    },
  },
  "/admin/support/tickets/{id}": {
    get: {
      tags: [ADMIN_TAG],
      summary: "One ticket: thread and the context the bot attached",
      security,
      ...planned("ilovelawyer-api#641"),
      parameters: [ticketId],
      responses: { 200: { description: "The ticket" }, ...adminOnly },
    },
  },
  "/admin/support/tickets/{id}/replies": {
    post: {
      tags: [ADMIN_TAG],
      summary: "Reply to a ticket",
      description: "Moves it to ANSWERED, emails the client, and sends the `support:reply` socket event. Audited.",
      security,
      ...planned("ilovelawyer-api#641"),
      parameters: [ticketId],
      requestBody: { required: true, content: json({ type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 4000 } } }) },
      responses: { 201: { description: "The reply" }, ...adminOnly },
    },
  },
  "/admin/support/tickets/{id}/resolve": {
    post: { tags: [ADMIN_TAG], summary: "Resolve a ticket", security, ...planned("ilovelawyer-api#641"), parameters: [ticketId], responses: { 200: { description: "Resolved" }, ...adminOnly } },
  },
  "/admin/support/tickets/{id}/reopen": {
    post: { tags: [ADMIN_TAG], summary: "Reopen a ticket", security, ...planned("ilovelawyer-api#641"), parameters: [ticketId], responses: { 200: { description: "Reopened" }, ...adminOnly } },
  },
  "/admin/support/report": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Support outcome report",
      description: "For a date range (`to` exclusive): per flow started, Yes and No counts and escalations; the overall escalation rate; the most frequent unmatched phrases.",
      security,
      ...planned("ilovelawyer-api#641"),
      parameters: [
        { name: "from", in: "query", required: true, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: true, schema: { type: "string", format: "date" } },
      ],
      responses: { 200: { description: "The report" }, ...adminOnly },
    },
  },
};
