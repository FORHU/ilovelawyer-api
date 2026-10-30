/** How the client app names the other people in a case. Stored as Party.designation. */
export const CLIENT_PARTY_ROLES = ["Opposing party", "Witness", "Other"] as const;

export const CLIENT_CASE_TITLE_MAX_LENGTH = 150;
export const CLIENT_CASE_WHERE_MAX_LENGTH = 120;
/** The most a client's own budget amount can be, in pence: £1,000,000. */
export const CLIENT_BUDGET_MAX_MINOR = 100_000_000;
export const CLIENT_MESSAGE_MAX_LENGTH = 4000;
/** Case documents one chat message can carry. */
export const CLIENT_MESSAGE_DOCUMENTS_MAX = 5;
/** How long the link the Documents tab opens a file with stays valid. The app fetches a fresh one
 * on every View, so it only has to outlive the click. */
export const CLIENT_DOCUMENT_LINK_SECONDS = 300;
/** "What happened" and "what I want", kept together in Case.notes. */
export const CLIENT_CASE_NOTES_MAX_LENGTH = 2000;
