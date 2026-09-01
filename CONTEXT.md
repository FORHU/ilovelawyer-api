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

## Example dialogue

> **Dev:** "Should logout delete the User's row in the DB?"
> **Domain expert:** "No — logout only ever touches a Session, never the User. It deletes the one Session tied to the refresh token the client sent."
> **Dev:** "So if I'm logged in on my phone and laptop, logging out on my phone kills both?"
> **Domain expert:** "No — each device gets its own Session when it logs in. Logging out on your phone deletes only your phone's Session row; your laptop's Session is untouched."
