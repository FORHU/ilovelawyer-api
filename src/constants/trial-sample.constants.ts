/** The consultation every trial guest starts with (TrialSvc.start): one finished UK question and
 * answer, so the chat opens on something real instead of an empty box. It uses well-known
 * authorities only, since a guest has no documents of their own. The snippets are summaries of
 * the holdings, not quotations. Not counted against the guest's answers. */
import type { RelatedCase } from "../utils/chatWonder";

export const TRIAL_SAMPLE_TITLE = "Remedies for a misrepresentation that induced a contract";

export const TRIAL_SAMPLE_QUESTION =
  "My client paid £240,000 after the other side said planning permission had already been granted. It hadn't. What are her remedies for misrepresentation, and what does she have to prove?";

export const TRIAL_SAMPLE_ANSWER = `Your client has two routes, and they differ in what she must prove.

## 1. Misrepresentation Act 1967, s.2(1)

If the statement was a false statement of fact that induced the contract, she can claim damages **unless** the maker proves he had reasonable grounds to believe, and did believe, it was true up to the time of the contract. The burden is on him, not on her. On these facts, "planning permission has already been granted" is a statement of existing fact, and the absence of any application is hard for him to explain.

Damages under s.2(1) are assessed as for fraud (*Royscot Trust Ltd v Rogerson* [1991] 2 QB 297), so she can recover losses that flow directly from the contract even if they were not foreseeable (*Smith New Court Securities Ltd v Scrimgeour Vickers (Asset Management) Ltd* [1997] AC 254).

## 2. Rescission

A representee who was induced to contract can rescind and recover the £240,000 with a claim to be restored to her pre-contract position. It is no answer that she could have checked the planning portal herself (*Redgrave v Hurd* (1881) 20 Ch D 1). Rescission can be lost by affirmation, delay, third-party rights or impossibility of restitution, and the court may award damages instead under s.2(2).

## 3. Deceit, only if you can plead it

If you can show he knew the statement was false, or was reckless as to whether it was true, the claim is in deceit (*Derry v Peek* (1889) 14 App Cas 337). It adds little to s.2(1) on damages, but it matters if there is an exclusion clause or you want to plead dishonesty.

## What she has to prove

- A false statement of fact (not opinion or intention) made to her.
- It induced her to enter the contract. It need not be the only reason.
- Loss caused by it.

Check any entire agreement or non-reliance clause in the contract: s.3 subjects exclusions of misrepresentation liability to the reasonableness test.

*This is a sample answer to show the format. Check every authority before relying on it.*`;

export const TRIAL_SAMPLE_RELATED_CASES: RelatedCase[] = [
  {
    type: "case",
    title: "Royscot Trust Ltd v Rogerson",
    url: null,
    case_number: "[1991] 2 QB 297",
    ra_number: null,
    year: 1991,
    snippet: "Damages under s.2(1) of the Misrepresentation Act 1967 are assessed on the tort of deceit measure.",
    relevance: null,
    vetted: true,
  },
  {
    type: "case",
    title: "Smith New Court Securities Ltd v Scrimgeour Vickers (Asset Management) Ltd",
    url: null,
    case_number: "[1997] AC 254",
    ra_number: null,
    year: 1997,
    snippet: "In deceit the victim recovers all direct loss from the transaction, whether or not it was foreseeable.",
    relevance: null,
    vetted: true,
  },
  {
    type: "case",
    title: "Redgrave v Hurd",
    url: null,
    case_number: "(1881) 20 Ch D 1",
    ra_number: null,
    year: 1881,
    snippet: "A party induced to contract by a misrepresentation may rescind even though they could have found out the truth.",
    relevance: null,
    vetted: true,
  },
  {
    type: "case",
    title: "Derry v Peek",
    url: null,
    case_number: "(1889) 14 App Cas 337",
    ra_number: null,
    year: 1889,
    snippet: "Fraud is proved when a false statement is made knowingly, without belief in its truth, or recklessly.",
    relevance: null,
    vetted: true,
  },
];
