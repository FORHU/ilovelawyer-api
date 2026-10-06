import type { ClientSide } from "@prisma/client";

/** Who the findings prompt's "this case" belongs to. Without it the prompt reads every case from
 * the claimant's side — on a prosecution that is the Crown, so the defence's lawyer got the
 * prosecution's weaknesses. Empty when the lawyer hasn't set Case.clientSide. */
export function clientSideSection(clientSide: ClientSide | null | undefined): string {
  if (!clientSide) return "";
  const side =
    clientSide === "CLAIMANT"
      ? "the CLAIMANT — the party that brought the case (claimant, applicant, appellant or the prosecution)"
      : "the RESPONDENT — the party defending the case (respondent, defendant or the accused)";
  return `
## CLIENT
You act for ${side}. Wherever the task says "this case", it means your client's case: Weaknesses hurt your client, Strengths help your client, Attack strategies are moves your client makes, and Defense strategies are what the other side will raise against your client. A gap in the other side's evidence is a Strength or an Attack strategy for your client, never a Weakness.${
    clientSide === "RESPONDENT"
      ? " For a defending client, evidence the other side needs but doesn't have is a Strength in its own right — for example no forensic link to your client, timings that don't fit the other side's account, or an identification that is weak or was led."
      : ""
  }
`;
}

/** The party the Attack strategies line advances — the client when known, else the default. */
export function attackParty(clientSide: ClientSide | null | undefined, fallback: string): string {
  return clientSide ? "your client" : fallback;
}
