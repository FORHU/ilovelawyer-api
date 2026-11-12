/** The id of the one Support Chat draft (SupportContentDraft). */
export const SUPPORT_DRAFT_ID = "default";

/** Every reason Publish can refuse the content (validateSupportContent). The client, the admin and
 * the Swagger contract list the same codes. */
export const SUPPORT_CONTENT_PROBLEM_CODES = [
  "UNKNOWN_PLACEHOLDER",
  "EMPTY_MENU",
  "DUPLICATE_ID",
  "MENU_FLOW_MISSING",
  "MENU_FLOW_AUDIENCE",
  "ID_MISMATCH",
  "TARGET_FLOW_MISSING",
  "FLOW_AUDIENCE_MISMATCH",
  "START_STEP_MISSING",
  "UNKNOWN_ACTION",
  "ACTION_AUDIENCE_MISMATCH",
  "TARGET_STEP_MISSING",
  "INVALID_LINK",
  "STEP_UNREACHABLE",
] as const;

export type SupportContentProblemCode = (typeof SUPPORT_CONTENT_PROBLEM_CODES)[number];
