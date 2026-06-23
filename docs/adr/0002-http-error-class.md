# Use a custom HttpError class instead of string-matching error messages

Services throw a custom `HttpError extends Error` carrying a `statusCode`, instead of plain `Error` with a message string. Controllers translate any thrown error into a response via `err.statusCode ?? 500`, rather than pattern-matching on specific message strings to infer what status code to return.

String-matching (`if (err.message === "Invalid email or password") return res.status(401)`) was the simpler alternative, but it ties every controller to the exact wording of every service's error messages — a typo or wording change in a service silently breaks the controller's status-code logic. `HttpError` makes the status code part of the thrown value itself, decoupling controllers from message text entirely. This isn't auth-specific — it's the error-handling convention for the whole API going forward.
