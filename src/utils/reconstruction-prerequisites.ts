/**
 * What a case still needs before Case Reconstruction's event chain can be built — worked out up
 * front so the lawyer is told which parts to fill in or wait on, instead of getting a bare
 * "nothing to build from" (and, for a queued job, only after it had already been accepted).
 *
 * The chain is built from the case's documents alone. It deliberately does not depend on the
 * narrative: the two are separate generations, and an earlier version that required one only did so
 * because of where the chain happened to be stored.
 * Pure: the caller passes in what it found.
 */

export type EventBlockerCode = "NO_DOCUMENTS" | "DOCUMENTS_PROCESSING" | "DOCUMENTS_FAILED";

export interface EventBlocker {
  code: EventBlockerCode;
  /** What is wrong, in plain words. */
  problem: string;
  /** What the lawyer should do about it. */
  action: string;
  /** Names of the documents involved, for the two document blockers. */
  documents?: string[];
}

export interface EventPrerequisiteInput {
  documents: { name: string; ragStatus: "PENDING" | "READY" | "FAILED" }[];
}

const LISTED_NAMES = 5;

function nameList(names: string[]): string {
  const shown = names.slice(0, LISTED_NAMES).join(", ");
  return names.length > LISTED_NAMES ? `${shown} and ${names.length - LISTED_NAMES} more` : shown;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Empty when the chain can be built. Only a lack of any processed document blocks on documents:
 * with at least one READY document, others still processing or failed are not a reason to refuse —
 * the chain is built from what is ready.
 */
export function findEventBlockers(input: EventPrerequisiteInput): EventBlocker[] {
  const blockers: EventBlocker[] = [];
  const pending = input.documents.filter((d) => d.ragStatus === "PENDING").map((d) => d.name);
  const failed = input.documents.filter((d) => d.ragStatus === "FAILED").map((d) => d.name);
  const ready = input.documents.length - pending.length - failed.length;

  if (ready < 1) {
    if (input.documents.length === 0) {
      blockers.push({
        code: "NO_DOCUMENTS",
        problem: "This case has no documents yet, and the event chain is built from the documents.",
        action: "Upload the case documents (pleadings, letters, emails, records) on the Evidence tab.",
      });
    }
    if (pending.length) {
      blockers.push({
        code: "DOCUMENTS_PROCESSING",
        problem: `${pending.length} ${plural(pending.length, "document is", "documents are")} still being processed: ${nameList(pending)}.`,
        action: "Wait for processing to finish — nothing has been read from them yet — then try again.",
        documents: pending,
      });
    }
    if (failed.length) {
      blockers.push({
        code: "DOCUMENTS_FAILED",
        problem: `${failed.length} ${plural(failed.length, "document", "documents")} could not be processed: ${nameList(failed)}.`,
        action: `Re-upload ${plural(failed.length, "it", "them")} (a scanned or password-protected PDF is the usual cause), or remove ${plural(failed.length, "it", "them")}.`,
        documents: failed,
      });
    }
  }

  return blockers;
}

export function blockersMessage(blockers: EventBlocker[]): string {
  const lines = blockers.map((b, i) => `${blockers.length > 1 ? `${i + 1}. ` : ""}${b.problem} ${b.action}`);
  return `The event chain can't be built yet. ${lines.join(" ")}`;
}
