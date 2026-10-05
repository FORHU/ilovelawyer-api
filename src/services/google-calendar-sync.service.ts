import EventRepo from "../repositories/event.repository";
import AuthRepo from "../repositories/auth.repository";
import GoogleCalendarSvc from "./google-calendar.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { GOOGLE_CALENDAR_DEFAULT_EVENT_MINUTES } from "../constants";

export const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type EventRow = NonNullable<Awaited<ReturnType<typeof EventRepo.findRawById>>>;

/** Appointment fields that appear on the Google copy — an update touching none of them (a
 * reminder timestamp, an acknowledgement) doesn't need a sync. */
export const GOOGLE_SYNCED_EVENT_FIELDS = ["status", "title", "type", "dateTime", "endDateTime", "clientEmail", "notes"] as const;

/** A cancelled appointment stays on Google Calendar, marked: this title prefix, Google's
 * "Graphite" colour, and shown as free time. Restoring it removes all three on the same event. */
export const CANCELLED_TITLE_PREFIX = "Cancelled: ";
const CANCELLED_COLOR_ID = "8";

/** Separates the user's notes (above, editable from Google) from the app-owned details below
 * it, which the pull ignores: the client and the type are only ever changed in the app. */
export const DESCRIPTION_MARKER = "— ilovelawyer —";
const DESCRIPTION_FOOTER = "Edits to the title, time and notes sync with ilovelawyer. Client and type are changed in the app.";
// Footer written by the first, one-way version of this sync (before DESCRIPTION_MARKER).
const LEGACY_FOOTER = "Scheduled in ilovelawyer";

/** The Google event body for an appointment. The client is listed in the description, not as
 * an attendee: an attendee would make Google email them an invitation. */
export function toGoogleEvent(event: EventRow) {
  const start = event.dateTime;
  const end = event.endDateTime ?? new Date(start.getTime() + GOOGLE_CALENDAR_DEFAULT_EVENT_MINUTES * 60_000);
  const cancelled = event.status === "cancelled";
  const notes = event.notes?.trim();
  const details = [DESCRIPTION_MARKER, `Type: ${event.type}`, event.clientEmail ? `Client: ${event.clientEmail}` : null, DESCRIPTION_FOOTER]
    .filter(Boolean)
    .join("\n");

  return {
    summary: cancelled ? `${CANCELLED_TITLE_PREFIX}${event.title}` : event.title,
    description: notes ? `${notes}\n\n${details}` : details,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    // null clears a colour/availability set while cancelled (PATCH semantics).
    colorId: cancelled ? CANCELLED_COLOR_ID : null,
    transparency: cancelled ? "transparent" : "opaque",
    extendedProperties: { private: { ilovelawyerEventId: event.id } },
  };
}

/** The user's notes from a Google description: everything above DESCRIPTION_MARKER. Without the
 * marker (the user deleted it, or a copy from the one-way version) the app-written lines are
 * dropped and the rest is taken as notes. Null when nothing is left. */
export function notesFromDescription(description: string | undefined | null): string | null {
  if (!description) return null;
  const markerAt = description.indexOf(DESCRIPTION_MARKER);
  const text =
    markerAt >= 0
      ? description.slice(0, markerAt)
      : description
          .split("\n")
          .filter((line) => !/^\[type:[^\]]*\]$/.test(line.trim()) && !/^(Client|Type): /.test(line.trim()))
          .filter((line) => line.trim() !== LEGACY_FOOTER && line.trim() !== DESCRIPTION_FOOTER)
          .join("\n");
  return text.trim() || null;
}

/** Strips the cancelled marker the app adds, so it never becomes part of the stored title. */
export function titleFromSummary(summary: string | undefined | null): string | null {
  const title = summary?.startsWith(CANCELLED_TITLE_PREFIX) ? summary.slice(CANCELLED_TITLE_PREFIX.length) : summary;
  return title?.trim() || null;
}

// Per-appointment queue shared by both directions: a create followed quickly by an edit must
// not both see "no Google copy yet" and insert two Google events, and a pull must not apply a
// Google change in the middle of a push for the same appointment. Single API process.
const pending = new Map<string, Promise<void>>();

export function enqueue(eventId: string, job: () => Promise<void>): Promise<void> {
  const run = (pending.get(eventId) ?? Promise.resolve()).then(job).catch((err) => {
    logger.error("Google Calendar sync failed", { err, eventId });
  });
  pending.set(eventId, run);
  void run.finally(() => {
    if (pending.get(eventId) === run) pending.delete(eventId);
  });
  return run;
}

/** Resolves once no sync work is queued — for tests, since EventSvc doesn't await the sync. */
export async function whenSyncIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending.values()]);
}

/** Null when the owner hasn't connected Google Calendar (nothing to do). A revoked grant is
 * cleared by GoogleCalendarSvc and also ends up here as "not connected". */
export async function ownerAccessToken(userId: string): Promise<string | null> {
  const tokens = await AuthRepo.findGoogleCalendarTokens(userId);
  if (!tokens?.googleRefreshToken) return null;
  try {
    return await GoogleCalendarSvc.getAccessToken(userId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409) {
      logger.warn("Google Calendar sync skipped: owner needs to reconnect Google Calendar", { userId });
      return null;
    }
    throw err;
  }
}

export async function googleFetch(accessToken: string, url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
  });
}

/** 404/410: the Google copy is already gone (deleted in Google, or by an earlier sync). */
const isGone = (res: Response) => res.status === 404 || res.status === 410;

async function failure(res: Response, action: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`Google Calendar ${action} failed: ${res.status} ${body.slice(0, 300)}`);
}

type GoogleEventResponse = { id?: string; htmlLink?: string; updated?: string };

/**
 * App → Google half of the two-way sync (GoogleCalendarPullSvc is the other half): keeps a copy
 * of each appointment on its owner's primary Google Calendar once they've connected Google
 * Calendar. Fire-and-forget from EventSvc — never blocks or fails the appointment change itself;
 * errors are logged. Every write records Google's `updated` time on the appointment
 * (googleUpdatedAt), so the pull recognises the change as its own when it comes back.
 */
export default class GoogleCalendarSyncSvc {
  /** Creates or updates the Google copy to match the appointment as it is now. A cancelled
   * appointment keeps its copy, marked as cancelled. */
  static syncEvent(eventId: string): Promise<void> {
    return enqueue(eventId, async () => {
      const event = await EventRepo.findRawById(eventId);
      if (!event) return;
      // Nothing to mark: it was cancelled before it ever reached Google, or Google deleted it.
      if (event.status === "cancelled" && !event.googleEventId) return;
      const accessToken = await ownerAccessToken(event.userId);
      if (!accessToken) return;

      const body = JSON.stringify(toGoogleEvent(event));
      if (event.googleEventId) {
        const res = await googleFetch(accessToken, `${EVENTS_URL}/${encodeURIComponent(event.googleEventId)}`, { method: "PATCH", body });
        if (res.ok) {
          const updated = (await res.json()) as GoogleEventResponse;
          await EventRepo.setGoogleRef(event.id, event.googleEventId, updated.htmlLink ?? event.googleLink, updated.updated);
          return;
        }
        if (!isGone(res)) throw await failure(res, "update");
        // Deleted in Google meanwhile. A cancelled appointment has nothing left to mark;
        // an active one gets a fresh copy.
        if (event.status === "cancelled") {
          await EventRepo.setGoogleRef(event.id, null, null, null);
          return;
        }
      }

      const res = await googleFetch(accessToken, EVENTS_URL, { method: "POST", body });
      if (!res.ok) throw await failure(res, "create");
      const created = (await res.json()) as GoogleEventResponse;
      if (created.id) await EventRepo.setGoogleRef(event.id, created.id, created.htmlLink ?? null, created.updated);
    });
  }

  /** After an appointment is deleted: removes its Google copy. Takes the row as it was before
   * the delete, since it can't be re-read. */
  static removeDeletedEvent(event: { id: string; userId: string; googleEventId: string | null }): Promise<void> {
    return enqueue(event.id, async () => {
      if (!event.googleEventId) return;
      const accessToken = await ownerAccessToken(event.userId);
      if (!accessToken) return;
      const res = await googleFetch(accessToken, `${EVENTS_URL}/${encodeURIComponent(event.googleEventId)}`, { method: "DELETE" });
      if (!res.ok && !isGone(res)) throw await failure(res, "delete");
    });
  }
}
