// The "How do you practice?" answers the onboarding tour offers. Each picks a step script in
// ilovelawyer-app's lib/tour/steps.ts — keep the two lists in sync.
export const PRODUCT_TOUR_ARCHETYPES = ["solo", "associate", "paralegal", "admin"] as const;
export type ProductTourArchetype = (typeof PRODUCT_TOUR_ARCHETYPES)[number];

// One tour per page, each run automatically on the user's first visit and saved here so it
// doesn't run again: the page tours ("consultation", "cases", "library", "calendar"), and
// "studio" / "terminal" (a case's Workspace and Legal Terminal, toured on the built-in sample
// case). The step scripts live in ilovelawyer-app's lib/tour and lib/sample-case.
export const PRODUCT_TOUR_TRACKS = ["consultation", "cases", "library", "calendar", "studio", "terminal"] as const;

// Step ids are short slugs ("ask", "newcase"); these bounds only keep junk out of the row.
export const PRODUCT_TOUR_STEP_ID_MAX = 40;
export const PRODUCT_TOUR_MAX_STEPS = 50;
