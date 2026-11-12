import type { SupportAudience } from "../constants/support-actions.constants";
import type { SupportContent, SupportFlow, SupportMenuCard } from "../types/support-content";

export const SUPPORT_AUDIENCES: SupportAudience[] = ["SIGNED_IN", "SIGNED_OUT"];

/** Whether a flow is shown to this audience. The one place that says so: publishing checks content
 * against it and clients are served through it. */
export const flowAvailableTo = (flow: SupportFlow, audience: SupportAudience) => flow.audience === "BOTH" || flow.audience === audience;

/** The flows an audience can reach, by id. */
export function flowsFor(content: SupportContent, audience: SupportAudience): Record<string, SupportFlow> {
  return Object.fromEntries(Object.entries(content.flows).filter(([, flow]) => flowAvailableTo(flow, audience)));
}

/** The menu cards an audience sees: switched on, and pointing at a flow it can reach. */
export function menuFor(content: SupportContent, audience: SupportAudience): SupportMenuCard[] {
  const flows = flowsFor(content, audience);
  return content.menus[audience].filter((card) => card.enabled && flows[card.flowId]);
}
