/** Longest message a client or admin can send in a Support Ticket. Text only, no attachments. */
export const SUPPORT_MESSAGE_MAX_LENGTH = 4000;

/** An OPEN ticket this old (since the client last wrote) is overdue: the greeting promises a reply
 * within one working day. */
export const SUPPORT_TICKET_OVERDUE_HOURS = 24;

/** An ANSWERED ticket the client doesn't reply to resolves itself after this long (SupportTicketSweepQueue). */
export const SUPPORT_TICKET_AUTO_RESOLVE_DAYS = 7;

/** The most outcome events one call may report. */
export const SUPPORT_OUTCOME_BATCH_MAX = 20;

/** The longest unmatched phrase kept for the report. */
export const SUPPORT_UNMATCHED_TEXT_MAX_LENGTH = 200;

/** Unmatched phrases in the report. */
export const SUPPORT_REPORT_TOP_UNMATCHED = 20;

/** The longest range the outcome report covers. */
export const SUPPORT_REPORT_MAX_DAYS = 366;

export const SUPPORT_TICKET_PAGE_SIZE = 25;

export const SUPPORT_CONTEXT_LIMITS = { flowPathLength: 12, flowIdLength: 80, pageLength: 200 } as const;

export const SUPPORT_AUTO_RESOLVE_NOTE = "This conversation was closed automatically after 7 days without a reply. Send a message to start it again.";
