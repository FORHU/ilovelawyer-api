# Signup creates the account only; it does not issue tokens

`POST /signup` creates the `User` row and returns a confirmation — no access/refresh tokens, no `Session` row. The client is expected to call `/login` separately afterward.

This mirrors the existing `law-ph` product behavior, where signing up redirects to the login page rather than logging the user in immediately. We're matching that UX rather than introducing auto-login, even though auto-login is the more common pattern elsewhere — consistency with the current product experience won out over convention. If the product later wants auto-login, `signup` and `login` would need to share the token-issuing logic (`loginToken` + `createSession`), which they don't today.
