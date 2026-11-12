import { SUPPORT_ACTIONS, actionAllowedFor, isKnownActionKey, type SupportAudience } from "../constants/support-actions.constants";
import type { SupportContent, SupportContentProblem, SupportFlow, SupportStep, SupportTarget } from "../types/support-content";

const ALLOWED_PLACEHOLDERS = new Set(["firstName"]);
const AUDIENCES: SupportAudience[] = ["SIGNED_IN", "SIGNED_OUT"];

const isSafeHref = (href: string) => /^https:\/\/\S+$/i.test(href) || /^\/(?!\/)\S*$/.test(href) || /^mailto:\S+$/i.test(href);

const flowAvailableTo = (flow: SupportFlow, audience: SupportAudience) => flow.audience === "BOTH" || flow.audience === audience;

/** Every target a step points at, with the path suffix to report a problem against. */
function targetsOf(step: SupportStep): { target: SupportTarget; at: string }[] {
  switch (step.type) {
    case "MESSAGE":
      return step.next ? [{ target: step.next, at: "next" }] : [];
    case "CHOICES":
      return step.options.map((option, i) => ({ target: option.target, at: `options[${i}].target` }));
    case "ACTION":
      return [
        { target: step.onSuccess, at: "onSuccess" },
        { target: step.onFailure, at: "onFailure" },
      ];
    default:
      return [];
  }
}

function textsOf(content: SupportContent): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [
    { path: "settings.assistantName", text: content.settings.assistantName },
    { path: "settings.greeting", text: content.settings.greeting },
    { path: "settings.responseTimeLine", text: content.settings.responseTimeLine },
  ];
  for (const audience of AUDIENCES) {
    content.menus[audience].forEach((card, i) => {
      out.push({ path: `menus.${audience}[${i}].title`, text: card.title });
      if (card.subtitle) out.push({ path: `menus.${audience}[${i}].subtitle`, text: card.subtitle });
    });
  }
  for (const [flowId, flow] of Object.entries(content.flows)) {
    out.push({ path: `flows.${flowId}.title`, text: flow.title });
    for (const [stepId, step] of Object.entries(flow.steps)) {
      const base = `flows.${flowId}.steps.${stepId}`;
      if ((step.type === "MESSAGE" || step.type === "CHOICES") && step.text) out.push({ path: `${base}.text`, text: step.text });
      if (step.type === "CHOICES") step.options.forEach((option, i) => out.push({ path: `${base}.options[${i}].label`, text: option.label }));
    }
  }
  return out;
}

/** Everything Publish refuses: broken links between steps and flows, unreachable steps, unknown
 * actions, account-reading actions on a signed-out path, unknown placeholders and unsafe links.
 * Pure: takes content that already has the right shape (supportContentSchema). */
export function validateSupportContent(content: SupportContent): SupportContentProblem[] {
  const problems: SupportContentProblem[] = [];
  const add = (path: string, code: string, message: string) => problems.push({ path, code, message });

  for (const { path, text } of textsOf(content)) {
    for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
      if (!ALLOWED_PLACEHOLDERS.has(match[1])) add(path, "UNKNOWN_PLACEHOLDER", `"{${match[1]}}" isn't supported. Only {firstName} is.`);
    }
  }

  for (const audience of AUDIENCES) {
    const cards = content.menus[audience];
    if (!cards.some((card) => card.enabled)) add(`menus.${audience}`, "EMPTY_MENU", `The ${audience === "SIGNED_IN" ? "signed-in" : "signed-out"} menu needs at least one card switched on.`);
    const seen = new Set<string>();
    cards.forEach((card, i) => {
      const path = `menus.${audience}[${i}]`;
      if (seen.has(card.id)) add(`${path}.id`, "DUPLICATE_ID", `Another card in this menu already uses the id "${card.id}".`);
      seen.add(card.id);
      const flow = content.flows[card.flowId];
      if (!flow) add(`${path}.flowId`, "MENU_FLOW_MISSING", `This card points to a flow that doesn't exist ("${card.flowId}").`);
      else if (!flowAvailableTo(flow, audience)) add(`${path}.flowId`, "MENU_FLOW_AUDIENCE", `"${flow.title}" isn't available to ${audience === "SIGNED_IN" ? "signed-in" : "signed-out"} clients.`);
    });
  }

  for (const [flowId, flow] of Object.entries(content.flows)) {
    const flowPath = `flows.${flowId}`;
    if (flow.id !== flowId) add(`${flowPath}.id`, "ID_MISMATCH", `The flow's id "${flow.id}" must match its key "${flowId}".`);

    for (const [stepId, step] of Object.entries(flow.steps)) {
      if (step.id !== stepId) add(`${flowPath}.steps.${stepId}.id`, "ID_MISMATCH", `The step's id "${step.id}" must match its key "${stepId}".`);
    }

    flow.relatedFlowIds.forEach((relatedId, i) => {
      const related = content.flows[relatedId];
      const path = `${flowPath}.relatedFlowIds[${i}]`;
      if (!related) add(path, "TARGET_FLOW_MISSING", `Related flow "${relatedId}" doesn't exist.`);
      else {
        for (const audience of AUDIENCES) {
          if (flowAvailableTo(flow, audience) && !flowAvailableTo(related, audience)) {
            add(path, "FLOW_AUDIENCE_MISMATCH", `"${related.title}" isn't available to every client who can see "${flow.title}".`);
            break;
          }
        }
      }
    });

    if (!flow.steps[flow.startStepId]) add(`${flowPath}.startStepId`, "START_STEP_MISSING", `The start step "${flow.startStepId}" doesn't exist.`);

    for (const [stepId, step] of Object.entries(flow.steps)) {
      const stepPath = `${flowPath}.steps.${stepId}`;

      if (step.type === "ACTION") {
        if (!isKnownActionKey(step.actionKey)) add(`${stepPath}.actionKey`, "UNKNOWN_ACTION", `"${step.actionKey}" isn't a Support Action.`);
        else {
          const def = SUPPORT_ACTIONS[step.actionKey];
          for (const audience of AUDIENCES) {
            if (flowAvailableTo(flow, audience) && !actionAllowedFor(def, audience)) {
              const who = audience === "SIGNED_OUT" ? "signed-out visitors" : "signed-in clients";
              add(`${stepPath}.actionKey`, "ACTION_AUDIENCE_MISMATCH", `"${def.label}" can't run for ${who}, and this flow is available to them.`);
              break;
            }
          }
        }
      }

      for (const { target, at } of targetsOf(step)) {
        const path = `${stepPath}.${at}`;
        if (target.kind === "STEP" && !flow.steps[target.stepId]) add(path, "TARGET_STEP_MISSING", `Points to a step that doesn't exist ("${target.stepId}").`);
        if (target.kind === "FLOW") {
          const next = content.flows[target.flowId];
          if (!next) add(path, "TARGET_FLOW_MISSING", `Points to a flow that doesn't exist ("${target.flowId}").`);
          else {
            for (const audience of AUDIENCES) {
              if (flowAvailableTo(flow, audience) && !flowAvailableTo(next, audience)) {
                add(path, "FLOW_AUDIENCE_MISMATCH", `"${next.title}" isn't available to every client who can see "${flow.title}".`);
                break;
              }
            }
          }
        }
        if (target.kind === "LINK" && !isSafeHref(target.href)) add(`${path}.href`, "INVALID_LINK", "A link must start with https://, mailto: or / (an app page).");
      }
    }

    const start = flow.steps[flow.startStepId];
    if (start) {
      const reached = new Set<string>([flow.startStepId]);
      const queue = [flow.startStepId];
      while (queue.length) {
        const step = flow.steps[queue.pop() as string];
        if (!step) continue;
        for (const { target } of targetsOf(step)) {
          if (target.kind === "STEP" && flow.steps[target.stepId] && !reached.has(target.stepId)) {
            reached.add(target.stepId);
            queue.push(target.stepId);
          }
        }
      }
      for (const stepId of Object.keys(flow.steps)) {
        if (!reached.has(stepId)) add(`${flowPath}.steps.${stepId}`, "STEP_UNREACHABLE", "Nothing leads to this step from the flow's start.");
      }
    }
  }

  return problems;
}
