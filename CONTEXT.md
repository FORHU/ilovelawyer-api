# ilovelawyer-api

Standalone backend API providing authentication (and, eventually, other domain services) for ilovelawyer — decoupled from the `law-ph` monolith it's replacing.

## Language

**Session**:
A single issued refresh token, created at login and tied to one device/client. A User can have multiple concurrent Sessions (one per device they're logged in on).
_Avoid_: "login record", "auth session" (as a synonym for "all of a user's logins" — that's not what one Session represents here)

**Logout**:
Revoking exactly one Session — the one tied to the refresh token presented in the request — by deleting its row. Does not affect a User's other active Sessions on other devices.
_Avoid_: "sign out everywhere" (a distinct, broader action — not yet built)

**Access Token**:
Short-lived JWT proving identity on a per-request basis. Verified statelessly (signature check only, no DB lookup) by `valid-session.middleware.ts`.
_Avoid_: "auth token" (ambiguous between this and Refresh Token)

**Refresh Token**:
Longer-lived JWT used only to mint a new Access Token once it expires. Persisted in a Session row (unlike the Access Token) so it can be revoked before its natural expiry — that's what makes Logout possible. Rotated on every use: refreshing deletes the old Session/token and creates a new one, rather than reusing the same Refresh Token until its original expiry.

**Tenant**:
A deployment-region boundary (`code`: "PH", "UK", ...), resolved from the request's subdomain. An Organization belongs to exactly one Tenant (required, not optional); a User has an optional direct Tenant link, used only for a solo practitioner not yet in an Organization. See `docs/adr/0002-tenant-region-boundary.md`. There is no separate `Jurisdiction` enum anymore — it was collapsed into Tenant, since the two were always set from the same value and never allowed to diverge; see `docs/adr/0004-collapse-jurisdiction-into-tenant.md`. The `TenantCode` TypeScript type (`types/tenant-code.ts`, `"PH" | "UK"`) is what `Jurisdiction` used to be — still threaded through the legal-domain registries (`legal/prompt-registry.ts`, `legal/deadline-engine.registry.ts`, `legal/legal-knowledge-provider.ts`) to select PH/UK behavior, just sourced from `Tenant.code` now.
_Avoid_: confusing with **TenantContext** (`utils/tenant-context.ts`) — a per-request value (userId + organizationId + role + tenantCode) resolved from organization membership. It carries a `tenantCode` field, but it is not itself a Tenant.
_Avoid_: "jurisdiction" for anything Tenant-related — that word is still legitimately used elsewhere for two unrelated concepts: `Case.jurisdiction` (a free-text court/venue field) and `JurisdictionModule` (a dormant, admin-toggleable legal-ruleset feature flag). Neither was touched by the Tenant/Jurisdiction collapse.
_Status: assigned from the request's Origin host at both signup (`User.tenantId` — password signup and first-time Google signup, via `TenantRepo.findIdByCode`) and Organization creation (`Organization.tenantId`). Signup leaves `tenantId` null if the origin doesn't resolve to a known Tenant (e.g. local dev, direct API calls) rather than rejecting the request; Organization creation still hard-rejects an unresolved origin, unchanged from before._

**Email Verification**:
A blocking gate on password-based Signup: a User's `isEmailVerified` flag starts `false` and Login is refused until it's flipped `true` by successfully completing OTP verification. Not required for Google signups — Google has already verified the email, so `isEmailVerified` is set `true` at account creation.
_Avoid_: "OTP" alone as the name of the gate (OTP is the mechanism — the one-time code — not the gate itself; the gate is Email Verification)
_Status: designed, not yet implemented — see Pending._

**Case Claim**:
A legal cause of action a lawyer is pursuing or defending against in a Case (e.g. "Breach of Contract") — `title` / `causeOfAction` / `description` on the `CaseClaim` model.
_Avoid_: "Claim" for the unrelated per-sentence attribution tags the AI attaches to generated prose (`ReconstructionClaim`, `RedTeamClaim`: `text` / `category: GROUNDED|INFERENCE|UNSUPPORTED` / `sourceLabel`) — those are called **Attribution** everywhere user-facing (e.g. the Case Brief export's Attribution tables), specifically to avoid a lawyer reading "Claims" in a document and thinking of pleaded causes of action instead of AI provenance. The underlying `ReconstructionClaim`/`RedTeamClaim` type names are legacy and unchanged by this distinction — only rendered/document-facing text and new writing should say "Attribution."

**Exhibit**:
A `Document` a lawyer has explicitly marked for inclusion in the Case Brief export, via a new `isExhibit` boolean on the `Document` model (default `false` — a document is not an Exhibit just by being uploaded to the case). Marked/unmarked through the existing `PATCH /api/documents/:id` endpoint.
_Avoid_: confusing with `ilovelawyer-app`'s unrelated, non-persisted "No verified exhibits for this scene" UI label (a reconstruction scene's source-document references) — that's a different, read-only concept with no `isExhibit`-style field behind it. Also avoid assuming every uploaded case `Document` is an Exhibit — the app's own glossary describes uploaded documents generically as "evidentiary," but that's broader than this flag; only explicitly-marked ones appear in the Case Brief's Exhibit list.

## Example dialogue

> **Dev:** "Should logout delete the User's row in the DB?"
> **Domain expert:** "No — logout only ever touches a Session, never the User. It deletes the one Session tied to the refresh token the client sent."
> **Dev:** "So if I'm logged in on my phone and laptop, logging out on my phone kills both?"
> **Domain expert:** "No — each device gets its own Session when it logs in. Logging out on your phone deletes only your phone's Session row; your laptop's Session is untouched."
