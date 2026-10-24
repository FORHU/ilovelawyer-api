/** The kinds of problem a client picks for a case in the client app, stored on Case.practiceArea.
 * Lawyer matching reads it (FORHU/ilovelawyer-app#862), so these are also the practice areas a
 * lawyer can take. Personal injury is left out on purpose: referral fees are banned there. */
export const CLIENT_CASE_AREAS = ["EMPLOYMENT", "PROPERTY", "FAMILY", "CONSUMER", "OTHER"] as const;
export type ClientCaseArea = (typeof CLIENT_CASE_AREAS)[number];

/** How the client app names the other people in a case. Stored as Party.designation. */
export const CLIENT_PARTY_ROLES = ["Opposing party", "Witness", "Other"] as const;

export const CLIENT_CASE_TITLE_MAX_LENGTH = 150;
export const CLIENT_CASE_WHERE_MAX_LENGTH = 120;
export const CLIENT_MESSAGE_MAX_LENGTH = 4000;
/** Case documents one chat message can carry. */
export const CLIENT_MESSAGE_DOCUMENTS_MAX = 5;
/** "What happened" and "what I want", kept together in Case.notes. */
export const CLIENT_CASE_NOTES_MAX_LENGTH = 2000;
