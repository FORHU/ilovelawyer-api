import type { SupportActionKey, SupportAudience } from "../constants/support-actions.constants";

/** The Support Chat's editable content (EPIC ilovelawyer-client#120): one JSON document. Admins edit
 * a draft; clients read a published version. ilovelawyer-client and ilovelawyer-admin copy these types. */

export type SupportTarget =
  | { kind: "STEP"; stepId: string }
  | { kind: "FLOW"; flowId: string }
  | { kind: "LINK"; href: string; label?: string }
  | { kind: "TALK_TO_PERSON" }
  | { kind: "END" };

export interface SupportChoiceOption {
  label: string;
  target: SupportTarget;
}

export type SupportStep =
  | { id: string; type: "MESSAGE"; text: string; next?: SupportTarget }
  | { id: string; type: "CHOICES"; text?: string; style: "BUTTONS" | "QUICK_REPLIES"; options: SupportChoiceOption[] }
  | { id: string; type: "ACTION"; actionKey: SupportActionKey; onSuccess: SupportTarget; onFailure: SupportTarget }
  | { id: string; type: "DID_THAT_HELP" };

export type SupportFlowAudience = SupportAudience | "BOTH";

export interface SupportFlow {
  id: string;
  title: string;
  audience: SupportFlowAudience;
  /** Words and phrases the client matches typed text against. */
  triggers: string[];
  /** Offered after "Did that help?" is answered No. */
  relatedFlowIds: string[];
  startStepId: string;
  steps: Record<string, SupportStep>;
}

export interface SupportMenuCard {
  id: string;
  title: string;
  subtitle?: string;
  flowId: string;
  enabled: boolean;
}

export interface SupportSettings {
  assistantName: string;
  avatarUrl: string | null;
  /** May contain {firstName}. */
  greeting: string;
  responseTimeLine: string;
}

export interface SupportContent {
  schemaVersion: 1;
  settings: SupportSettings;
  menus: { SIGNED_IN: SupportMenuCard[]; SIGNED_OUT: SupportMenuCard[] };
  flows: Record<string, SupportFlow>;
}

export interface SupportContentProblem {
  /** Where in the content, e.g. "flows.refund.steps.ask.options[1].target". */
  path: string;
  code: string;
  message: string;
}

/** What GET /api/client/support/content and GET /api/support/content return. */
export interface PublishedSupportContent {
  version: number;
  publishedAt: Date;
  settings: SupportSettings;
  /** The enabled menu cards for the audience, in order. */
  menu: SupportMenuCard[];
  /** Only the flows available to the audience. */
  flows: Record<string, SupportFlow>;
  actions: { key: SupportActionKey; label: string; safetyCopy?: string[] }[];
}
