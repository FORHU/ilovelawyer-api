import Joi from "joi";
import { FEEDBACK_CATEGORIES, FEEDBACK_COMMENT_MAX_CHARS } from "../constants/feedback.constants";

const comment = Joi.string().trim().max(FEEDBACK_COMMENT_MAX_CHARS);

// What each source must carry:
// - GENERAL (the header drawer): a comment; a category is optional.
// - CHAT_ANSWER (a thumb): a rating and the answer's message id. A thumbs-up may go without a comment; a thumbs-down may not.
// - TERMINAL_PANE (the flag on a pane): the pane id, the case and a comment.
// The client names where the feedback came from, never what the answer said: ids and the person's own words only.
export const submitFeedbackSchema = Joi.object({
  source: Joi.string().valid("GENERAL", "CHAT_ANSWER", "TERMINAL_PANE").required(),
  rating: Joi.string().valid("UP", "DOWN").when("source", { is: "CHAT_ANSWER", then: Joi.required(), otherwise: Joi.forbidden() }),
  // Optional: a tester can send a comment without classifying it.
  category: Joi.string()
    .valid(...FEEDBACK_CATEGORIES)
    .when("source", { is: "GENERAL", then: Joi.optional(), otherwise: Joi.forbidden() }),
  comment: Joi.when("source", {
    is: "CHAT_ANSWER",
    then: Joi.when("rating", { is: "UP", then: comment.allow("").optional(), otherwise: comment.min(1).required() }),
    otherwise: comment.min(1).required(),
  }),
  organizationId: Joi.string().max(64).optional(),
  caseId: Joi.string().max(64).when("source", { is: "TERMINAL_PANE", then: Joi.required(), otherwise: Joi.optional() }),
  // Sent with a chat answer as well as its message id, so the feedback can still be filed under the
  // conversation when the message itself isn't saved yet.
  consultationId: Joi.string().max(64).optional(),
  messageId: Joi.string().max(64).when("source", { is: "CHAT_ANSWER", then: Joi.required(), otherwise: Joi.optional() }),
  panelId: Joi.string()
    .pattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
    .when("source", { is: "TERMINAL_PANE", then: Joi.required(), otherwise: Joi.forbidden() }),
  // The route only: no query string or fragment, which can carry ids or search text.
  pagePath: Joi.string().max(300).pattern(/^\/[^?#]*$/).optional(),
  viewport: Joi.string().pattern(/^\d{2,5}x\d{2,5}$/).optional(),
});
