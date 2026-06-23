# Rotate refresh tokens on every /refresh call

`/refresh` deletes the `Session` row for the presented refresh token and creates a brand-new one (new refresh token, new `Session` row), rather than reusing the same refresh token until its original expiry.

We chose rotation over reuse because it gives breach detection for free: a stolen-but-unused refresh token is silently invalidated the next time the real user refreshes, and any later attempt to reuse the now-dead old token is a clear signal of token theft (a production implementation should treat that as cause to revoke all of that User's Sessions). Reuse is simpler but leaves a stolen token valid for its entire lifetime with no way to notice. This is standard practice in OAuth2-style refresh flows.
