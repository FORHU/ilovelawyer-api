import type { SupportMessageAuthor, SupportTicketSource, SupportTicketStatus } from "@prisma/client";

/** What a Support Ticket carries about where it came from (SupportTicketSvc builds it). Ids, statuses
 * and a page path only: never case documents, AI chat, party names or a case's title (which can
 * name a party). */
export interface SupportTicketContext {
  name: string | null;
  email: string;
  /** The Support Flow ids the client walked through, oldest first. */
  flowPath: string[];
  /** The app page it was opened from, as a path without query or hash. */
  page: string | null;
  caseId: string | null;
  clientRequestId: string | null;
  clientRequestStatus: string | null;
}

/** What the client says about where it is; the API checks the ids and fills in the rest. */
export interface SupportTicketContextInput {
  flowPath?: string[];
  page?: string;
  caseId?: string;
  clientRequestId?: string;
}

export interface SupportMessageDto {
  id: string;
  author: SupportMessageAuthor;
  body: string;
  createdAt: Date;
}

/** The client's side of a ticket (GET /api/client/support/ticket). */
export interface SupportThreadDto {
  id: string;
  status: SupportTicketStatus;
  messages: SupportMessageDto[];
  /** Admin replies the client hasn't seen: drives the Guide's red dot. */
  unreadCount: number;
}

/** Socket event `support:reply`, sent to the client's `user:<id>` room when an admin replies. */
export interface SupportReplyEvent {
  ticketId: string;
  messageId: string;
}

export interface SupportTicketRowDto {
  id: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  userId: string | null;
  email: string;
  name: string | null;
  flowId: string | null;
  firstMessage: string;
  createdAt: Date;
  lastMessageAt: Date;
  /** Hours since the ticket was opened. */
  ageHours: number;
  /** OPEN for more than 24 hours since the client last wrote. */
  overdue: boolean;
}

export interface SupportOutcomeInput {
  kind: "FLOW_STARTED" | "HELPED_YES" | "HELPED_NO" | "ESCALATED" | "UNMATCHED";
  flowId?: string;
  contentVersion?: number;
  text?: string;
}
