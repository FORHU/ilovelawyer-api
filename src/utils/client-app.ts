import { Request } from "express";
import { Role } from "@prisma/client";
import { getRequestContext } from "../lib/request-context";

/**
 * Which frontend a request comes from. ilovelawyer-app (lawyers) and the client app share this
 * API and its User table, and every account belongs to exactly one of them through its role:
 * LAWYER for ilovelawyer-app, USER for the client app. ADMIN accounts use ilovelawyer-admin and
 * aren't tied to either.
 *
 * The client app sends `X-Client-App: user` on every request. Anything else, including no header
 * at all (what ilovelawyer-app, ilovelawyer-admin and older builds send), is the lawyer app.
 *
 * Not a security boundary on its own: the header only picks the role a NEW account gets, and a
 * LAWYER account still waits for admin approval. What an existing account can reach is decided
 * by its stored role, never by this header.
 */
export type ClientApp = "lawyer" | "user";

export const CLIENT_APP_HEADER = "x-client-app";

export function resolveClientApp(req: Request): ClientApp {
  return req.headers[CLIENT_APP_HEADER] === "user" ? "user" : "lawyer";
}

/** The current request's app (see requestContextMiddleware); the lawyer app outside a request. */
export function currentClientApp(): ClientApp {
  return getRequestContext()?.clientApp ?? "lawyer";
}

export function roleForClientApp(app: ClientApp): Role {
  return app === "user" ? "USER" : "LAWYER";
}
