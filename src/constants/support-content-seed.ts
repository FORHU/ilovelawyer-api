import type { SupportActionKey } from "./support-actions.constants";
import type {
  SupportChoiceOption,
  SupportContent,
  SupportFlow,
  SupportFlowAudience,
  SupportMenuCard,
  SupportStep,
  SupportTarget,
} from "../types/support-content";

const step = (stepId: string): SupportTarget => ({ kind: "STEP", stepId });
const flowTo = (flowId: string): SupportTarget => ({ kind: "FLOW", flowId });
const link = (href: string, label?: string): SupportTarget => ({ kind: "LINK", href, ...(label ? { label } : {}) });
const TALK: SupportTarget = { kind: "TALK_TO_PERSON" };
const END: SupportTarget = { kind: "END" };

const msg = (id: string, text: string, next?: SupportTarget): SupportStep => ({ id, type: "MESSAGE", text, ...(next ? { next } : {}) });
const choices = (id: string, text: string, options: SupportChoiceOption[], style: "BUTTONS" | "QUICK_REPLIES" = "BUTTONS"): SupportStep => ({
  id,
  type: "CHOICES",
  text,
  style,
  options,
});
const act = (id: string, actionKey: SupportActionKey, onSuccess: SupportTarget, onFailure: SupportTarget): SupportStep => ({
  id,
  type: "ACTION",
  actionKey,
  onSuccess,
  onFailure,
});
const helped = (id = "help"): SupportStep => ({ id, type: "DID_THAT_HELP" });
const opt = (label: string, target: SupportTarget): SupportChoiceOption => ({ label, target });

function flow(
  id: string,
  title: string,
  audience: SupportFlowAudience,
  triggers: string[],
  relatedFlowIds: string[],
  steps: SupportStep[],
): SupportFlow {
  return { id, title, audience, triggers, relatedFlowIds, startStepId: steps[0].id, steps: Object.fromEntries(steps.map((s) => [s.id, s])) };
}

/** A flow that goes straight to a person: the bot explains, then offers the ticket. */
const toPerson = (id: string, title: string, audience: SupportFlowAudience, triggers: string[], text: string) =>
  flow(id, title, audience, triggers, [], [choices("start", text, [opt("Talk to a person", TALK), opt("Back to the menu", END)])]);

const card = (id: string, title: string, subtitle: string, flowId: string): SupportMenuCard => ({ id, title, subtitle, flowId, enabled: true });

const signedInFlows: SupportFlow[] = [
  // Getting started
  flow("getting-started", "Getting started", "SIGNED_IN", [], [], [
    choices("start", "Getting started with ilovelawyer. What would you like to know?", [
      opt("What does ilovelawyer do?", flowTo("what-it-does")),
      opt("Starting a case", flowTo("start-case")),
      opt("Touring the app", flowTo("guide-tours")),
    ]),
  ]),
  flow("what-it-does", "What ilovelawyer does", "SIGNED_IN", ["what is this", "what does it do", "about", "how does it work"], ["start-case", "guide-tours"], [
    msg("start", "ilovelawyer helps you explain your situation, keep your documents in one place, and, if you want, ask a lawyer to take on your case.", step("more")),
    msg("more", "The AI chat helps you organise what happened and what you have. It gathers information for you and any lawyer you choose. It doesn't give legal advice.", step("help")),
    helped(),
  ]),
  flow("start-case", "Starting a case", "SIGNED_IN", ["start", "new case", "create case", "get started", "begin", "first case"], ["what-it-does", "guide-tours"], [
    msg("start", "Creating a case is free. Describe what happened in your own words, and add any documents you have.", step("go")),
    choices("go", "Ready to start?", [opt("Start a new case", link("/cases/new", "Start a new case")), opt("Not now", step("help"))]),
    helped(),
  ]),
  flow("guide-tours", "Touring the app", "SIGNED_IN", ["tour", "guide", "walkthrough", "show me around", "tutorial", "where is"], ["start-case", "what-it-does"], [
    msg("start", "The Guide button (the question mark in the menu) walks you through any page, and answers common how-do-I questions.", step("help")),
    helped(),
  ]),

  // Credits & payments
  flow("credits-payments", "Credits & payments", "SIGNED_IN", [], [], [
    choices("start", "Credits and payments. What's the problem?", [
      opt("How do credits work?", flowTo("credits-how")),
      opt("I ran out of credits", flowTo("credits-ran-out")),
      opt("My top-up didn't add credits", flowTo("topup-missing")),
      opt("My promo code didn't work", flowTo("promo")),
      opt("I want a refund", flowTo("refund")),
      opt("A charge looks wrong", flowTo("disputed-charge")),
      opt("Paying a lawyer's quote", flowTo("pay-quote")),
    ]),
  ]),
  flow("credits-how", "How credits work", "SIGNED_IN", ["credits", "credit balance", "how many credits", "chat credits", "how much", "free credits", "cost"], ["credits-ran-out", "topup-missing"], [
    msg("start", "Starting a case is free. Each message you send to the AI uses one Chat Credit, and credits belong to the case they were added to.", step("check")),
    act("check", "SHOW_CREDITS", step("help"), step("fail")),
    msg("fail", "I couldn't load your credits just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  flow("credits-ran-out", "I ran out of credits", "SIGNED_IN", ["ran out", "no credits", "out of credits", "buy credits", "top up", "topup", "add credits", "more credits"], ["credits-how", "topup-missing"], [
    msg("start", "You can add credits to a case with a top-up. Open the case and choose Add credits in the chat. Credits are added to that case only.", step("help")),
    helped(),
  ]),
  flow("topup-missing", "My top-up didn't add credits", "SIGNED_IN", ["top up", "topup", "payment", "paid", "credits missing", "not added", "charged", "pending", "didn't get credits"], ["credits-how", "refund", "disputed-charge"], [
    msg("start", "Let me check your recent payments.", step("check")),
    act("check", "CHECK_PAYMENT", step("help"), step("fail")),
    msg("fail", "I couldn't check your payments just now. If you were charged and have no credits, a person can look into it.", step("offer")),
    choices("offer", "Would you like to talk to a person?", [opt("Talk to a person", TALK), opt("No thanks", END)]),
    helped(),
  ]),
  flow("promo", "My promo code didn't work", "SIGNED_IN", ["promo", "promo code", "coupon", "discount", "voucher", "code not working"], ["credits-how", "topup-missing"], [
    msg("start", "Promo codes come off a credit top-up. Check the spelling, and note that some codes are only for a first top-up, can be used once, or have expired.", step("more")),
    msg("more", "The code is entered when you choose a top-up pack, before you pay. If it still says it isn't valid, tell me and I'll offer you a person.", step("help")),
    helped(),
  ]),
  toPerson(
    "refund",
    "I want a refund",
    "SIGNED_IN",
    ["refund", "money back", "get my money", "cancel payment", "reimburse"],
    "Refunds are decided by our team. I'll pass your request to a person, who will reply to you.",
  ),
  toPerson(
    "disputed-charge",
    "A charge looks wrong",
    "SIGNED_IN",
    ["double charge", "charged twice", "dispute", "chargeback", "wrong charge", "unauthorised", "unauthorized", "overcharged"],
    "I'm sorry about that. A charge that looks wrong needs a person to look at it. I'll pass it to our team.",
  ),
  flow("pay-quote", "Paying a lawyer's quote", "SIGNED_IN", ["quote", "pay lawyer", "pay the lawyer", "quotation", "fee", "invoice", "lawyer's price"], ["request-status"], [
    msg("start", "When a lawyer sends a quote, you'll see it on the Lawyer tab of your case. Accepting it fixes the amount, then you pay it through ilovelawyer by card. Paying starts the engagement.", step("check")),
    act("check", "SHOW_LAWYER_REQUESTS", step("help"), step("fail")),
    msg("fail", "I couldn't load your requests just now. Please try again in a moment.", step("help")),
    helped(),
  ]),

  // My lawyer request
  flow("lawyer-request", "My lawyer request", "SIGNED_IN", [], [], [
    choices("start", "Your lawyer request. What do you need?", [
      opt("What does my request's status mean?", flowTo("request-status")),
      opt("My request expired", flowTo("request-expired")),
      opt("Withdraw a request", flowTo("request-withdraw")),
      opt("End my engagement", flowTo("request-end")),
      opt("A complaint about a lawyer", flowTo("lawyer-complaint")),
    ]),
  ]),
  flow("request-status", "What my request's status means", "SIGNED_IN", ["status", "request status", "claimed", "routed", "waiting for a lawyer", "where is my request", "lawyer request"], ["request-expired", "pay-quote"], [
    msg("start", "Let me show your requests.", step("check")),
    act("check", "SHOW_LAWYER_REQUESTS", step("explain"), step("fail")),
    msg("explain", "Requested or routed: we're finding lawyers who match. Claimed: a lawyer is reviewing it. Quoted: a lawyer sent you a quote. Confirmed or engaged: you're working together. Closed: finished.", step("help")),
    msg("fail", "I couldn't load your requests just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  flow("request-expired", "My request expired", "SIGNED_IN", ["expired", "request expired", "no lawyer", "nobody claimed", "no one took", "no response"], ["request-status", "request-withdraw"], [
    msg("start", "A request that no lawyer takes up in time expires. It costs you nothing, and you can send a new one from your case's Lawyer tab.", step("help")),
    helped(),
  ]),
  flow("request-withdraw", "Withdraw a request", "SIGNED_IN", ["withdraw", "cancel request", "cancel my request", "take back"], ["request-status", "request-end"], [
    msg("start", "You can withdraw a request that hasn't started yet. Here are your requests.", step("check")),
    act("check", "SHOW_LAWYER_REQUESTS", step("how"), step("fail")),
    msg("how", "Open the request from its link and choose Withdraw. Once you're working with a lawyer, you end the engagement instead.", step("help")),
    msg("fail", "I couldn't load your requests just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  flow("request-end", "End my engagement", "SIGNED_IN", ["end engagement", "end my engagement", "stop working with lawyer", "finish", "close engagement", "end lawyer"], ["request-withdraw", "lawyer-complaint"], [
    msg("start", "You can end an engagement from the request's page: choose End engagement and follow the steps. Here are your requests.", step("check")),
    act("check", "SHOW_LAWYER_REQUESTS", step("help"), step("fail")),
    msg("fail", "I couldn't load your requests just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  toPerson(
    "lawyer-complaint",
    "A complaint about a lawyer",
    "SIGNED_IN",
    ["complaint", "complain", "bad lawyer", "rude", "unprofessional", "report lawyer", "unhappy with lawyer"],
    "I'm sorry you had a bad experience. A complaint about a lawyer is handled by our team, not the chat. I'll pass it to a person.",
  ),

  // Account & sign-in
  flow("account", "Account & sign-in", "SIGNED_IN", [], [], [
    choices("start", "Your account. What do you need?", [
      opt("Change my password", flowTo("change-password")),
      opt("Export my data", flowTo("export-data")),
      opt("Delete my account", flowTo("delete-account")),
    ]),
  ]),
  flow("change-password", "Change my password", "SIGNED_IN", ["password", "change password", "reset password", "new password", "forgot password"], ["export-data", "delete-account"], [
    msg("start", "I can email you a link to set a new password.", step("send")),
    act("send", "SEND_PASSWORD_RESET", step("sent"), step("fail")),
    msg("sent", "Done. Check your inbox (and spam) for the reset link.", step("help")),
    msg("fail", "I couldn't send that just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  flow("export-data", "Export my data", "SIGNED_IN", ["export", "download my data", "my data", "data copy", "copy of my data"], ["delete-account"], [
    msg("start", "You can download a copy of your data as a ZIP file.", step("run")),
    act("run", "EXPORT_MY_DATA", step("done"), step("fail")),
    msg("done", "Your download is ready.", step("help")),
    msg("fail", "I couldn't prepare your export. Check your password and try again.", step("help")),
    helped(),
  ]),
  flow("delete-account", "Delete my account", "SIGNED_IN", ["delete", "delete account", "close account", "remove account", "gdpr", "erase", "delete my data"], ["export-data"], [
    act("start", "DELETE_MY_ACCOUNT", step("done"), step("fail")),
    msg("done", "Your account is scheduled for deletion. If you change your mind, sign in within 30 days and it's cancelled.", step("help")),
    msg("fail", "Your account wasn't deleted.", step("help")),
    helped(),
  ]),

  // Report an issue
  toPerson(
    "report-issue",
    "Report an issue",
    "SIGNED_IN",
    ["bug", "broken", "error", "not working", "crash", "glitch", "problem", "issue", "report"],
    "Sorry something isn't working. A person can look into it. Tell them what you were doing and what went wrong, and we'll attach the page you're on.",
  ),

  // Not in the menu: reached by typed text only
  flow(
    "legal-question",
    "A legal question",
    "SIGNED_IN",
    ["can i sue", "my rights", "is it legal", "legal advice", "advice", "should i", "will i win", "am i allowed", "what are my chances", "what should i do"],
    ["what-it-does"],
    [
      msg("start", "I can't answer legal questions or give legal advice. I'm here to help with using ilovelawyer.", step("chat")),
      msg("chat", "To get your situation organised, use your case's AI chat. It gathers the facts and documents for you and any lawyer you choose. For advice, you'll need a lawyer.", step("help")),
      helped(),
    ],
  ),
];

const signedOutFlows: SupportFlow[] = [
  flow("so-cant-sign-in", "I can't sign in", "SIGNED_OUT", ["can't sign in", "cannot sign in", "cant sign in", "locked out", "login", "log in", "sign in", "signin"], ["so-forgot-password", "so-no-code"], [
    msg("start", "Let's work it out. Check that your email address is spelled correctly, and that you're using the same method as when you signed up (Google or email and password).", step("next")),
    choices("next", "What's happening?", [
      opt("I forgot my password", flowTo("so-forgot-password")),
      opt("I didn't get my code", flowTo("so-no-code")),
      opt("Something else", flowTo("so-something-else")),
    ]),
  ]),
  flow("so-no-code", "I didn't get my code", "SIGNED_OUT", ["code", "otp", "verification", "no email", "didn't get", "not received", "didn't receive"], ["so-cant-sign-in"], [
    msg("start", "Check your spam or junk folder first. The email can take a minute or two to arrive. I can send a new code.", step("send")),
    act("send", "RESEND_CODE", step("sent"), step("fail")),
    msg("sent", "If that email has an account, a new code is on its way.", step("help")),
    msg("fail", "I couldn't send that just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  flow("so-forgot-password", "I forgot my password", "SIGNED_OUT", ["forgot", "forgotten", "reset password", "password", "new password"], ["so-cant-sign-in"], [
    msg("start", "I can email you a link to set a new password.", step("send")),
    act("send", "SEND_PASSWORD_RESET", step("sent"), step("fail")),
    msg("sent", "If that email has an account, a reset link is on its way. Check your spam folder too.", step("help")),
    msg("fail", "I couldn't send that just now. Please try again in a moment.", step("help")),
    helped(),
  ]),
  flow("so-cancel-deletion", "Cancel my account deletion", "SIGNED_OUT", ["cancel deletion", "undo delete", "restore account", "deleted my account", "recover", "get my account back"], ["so-cant-sign-in"], [
    msg("start", "An account scheduled for deletion is kept for 30 days. Signing in during that time cancels the deletion.", step("go")),
    choices("go", "Want to sign in now?", [opt("Sign in", link("/login", "Sign in")), opt("Not now", step("help"))]),
    helped(),
  ]),
  toPerson(
    "so-something-else",
    "Something else",
    "SIGNED_OUT",
    ["help", "other", "something else", "contact", "support", "problem"],
    "I'll pass this to a person. Give us your email address and tell us what's wrong, and we'll reply by email.",
  ),
];

export const SUPPORT_CONTENT_V1: SupportContent = {
  schemaVersion: 1,
  settings: {
    assistantName: "Lexi",
    avatarUrl: null,
    greeting: "Hi {firstName}, I'm Lexi. I can help you use ilovelawyer. What do you need?",
    responseTimeLine: "If I can't help, a person will reply within one working day.",
  },
  menus: {
    SIGNED_IN: [
      card("m-getting-started", "Getting started", "What ilovelawyer does and how to begin", "getting-started"),
      card("m-credits", "Credits & payments", "Credits, top-ups, promo codes, refunds", "credits-payments"),
      card("m-lawyer", "My lawyer request", "Status, quotes, withdrawing, ending", "lawyer-request"),
      card("m-account", "Account & sign-in", "Password, your data, closing your account", "account"),
      card("m-issue", "Report an issue", "Something isn't working", "report-issue"),
    ],
    SIGNED_OUT: [
      card("o-cant-sign-in", "I can't sign in", "Get back into your account", "so-cant-sign-in"),
      card("o-no-code", "I didn't get my code", "Send it again", "so-no-code"),
      card("o-forgot", "I forgot my password", "Reset it by email", "so-forgot-password"),
      card("o-cancel-deletion", "Cancel my account deletion", "Changed your mind?", "so-cancel-deletion"),
      card("o-other", "Something else", "Tell us what is wrong", "so-something-else"),
    ],
  },
  flows: Object.fromEntries([...signedInFlows, ...signedOutFlows].map((f) => [f.id, f])),
};
