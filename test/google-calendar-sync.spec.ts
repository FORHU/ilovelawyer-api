/** GoogleCalendarSyncSvc — one-way sync of appointments to the owner's Google Calendar, and
 * EventSvc's hooks into it.
 *
 * No live Postgres/Google: EventRepo, AuthRepo, GoogleCalendarSvc and the global fetch are
 * monkeypatched, same idiom as test/avatar-and-google-calendar.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import GoogleCalendarSyncSvc, { toGoogleEvent } from "../src/services/google-calendar-sync.service";
import GoogleCalendarSvc from "../src/services/google-calendar.service";
import EventSvc from "../src/services/event.service";
import EventRepo from "../src/repositories/event.repository";
import AuthRepo from "../src/repositories/auth.repository";
import NotificationSvc from "../src/services/notification.service";
import HttpError from "../src/utils/http-error";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    userId: "owner-1",
    organizationId: "org-1",
    title: "Consultation",
    type: "Meeting",
    dateTime: new Date("2026-10-03T05:00:00.000Z"),
    endDateTime: null as Date | null,
    clientEmail: "client@example.com",
    notes: "Bring the contract",
    status: "pending",
    googleLink: null as string | null,
    googleEventId: null as string | null,
    ...overrides,
  };
}

describe("GoogleCalendarSyncSvc", () => {
  let restore: (() => void)[];
  let row: ReturnType<typeof eventRow> | null;
  let connected: boolean;
  let accessTokenError: Error | null;
  let googleRefs: { id: string; googleEventId: string | null; googleLink: string | null }[];
  let calls: { method: string; url: string; body?: any }[];
  let respond: (method: string, url: string) => Response;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    row = eventRow();
    connected = true;
    accessTokenError = null;
    googleRefs = [];
    calls = [];
    respond = (method) =>
      method === "POST"
        ? new Response(JSON.stringify({ id: "g-1", htmlLink: "https://calendar.google.com/event?eid=g-1" }), { status: 200 })
        : new Response(method === "DELETE" ? null : "{}", { status: method === "DELETE" ? 204 : 200 });

    restore = [
      stash(EventRepo as any, ["findRawById", "setGoogleRef", "create", "updateById", "deleteById", "findById"]),
      stash(AuthRepo as any, ["findGoogleCalendarTokens"]),
      stash(GoogleCalendarSvc as any, ["getAccessToken"]),
      stash(NotificationSvc as any, ["create"]),
    ];
    (EventRepo as any).findRawById = async () => row;
    (EventRepo as any).setGoogleRef = async (id: string, googleEventId: string | null, googleLink: string | null) => {
      googleRefs.push({ id, googleEventId, googleLink });
      if (row) Object.assign(row, { googleEventId, googleLink });
    };
    (AuthRepo as any).findGoogleCalendarTokens = async () =>
      connected ? { googleAccessToken: "a", googleRefreshToken: "v1:enc" } : { googleAccessToken: null, googleRefreshToken: null };
    (GoogleCalendarSvc as any).getAccessToken = async () => {
      if (accessTokenError) throw accessTokenError;
      return "access-1";
    };
    (NotificationSvc as any).create = async () => ({});
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return respond(method, String(url));
    }) as typeof fetch;
  });

  afterEach(() => {
    restore.forEach((r) => r());
    globalThis.fetch = realFetch;
  });

  it("builds the Google event: 1h default, type tag, client in the description (no attendees)", () => {
    const body = toGoogleEvent(eventRow() as any);
    expect(body.summary).to.equal("Consultation");
    expect(body.start.dateTime).to.equal("2026-10-03T05:00:00.000Z");
    expect(body.end.dateTime).to.equal("2026-10-03T06:00:00.000Z");
    expect(body.description).to.equal("[type:meeting]\nBring the contract\nClient: client@example.com\nScheduled in ilovelawyer");
    expect(body).not.to.have.property("attendees");
    expect(body.extendedProperties.private.ilovelawyerEventId).to.equal("evt-1");
  });

  it("creates the Google copy and saves its id and link on the appointment", async () => {
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).to.deep.equal([`POST ${EVENTS_URL}`]);
    expect(googleRefs).to.deep.equal([{ id: "evt-1", googleEventId: "g-1", googleLink: "https://calendar.google.com/event?eid=g-1" }]);
  });

  it("updates the existing Google copy instead of creating another", async () => {
    row = eventRow({ googleEventId: "g-1", title: "Moved" });
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls).to.have.length(1);
    expect(calls[0].method).to.equal("PATCH");
    expect(calls[0].url).to.equal(`${EVENTS_URL}/g-1`);
    expect(calls[0].body.summary).to.equal("Moved");
  });

  it("re-creates the copy when it was deleted in Google", async () => {
    row = eventRow({ googleEventId: "g-old" });
    respond = (method) =>
      method === "PATCH" ? new Response("gone", { status: 410 }) : new Response(JSON.stringify({ id: "g-2", htmlLink: "l" }), { status: 200 });
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls.map((c) => c.method)).to.deep.equal(["PATCH", "POST"]);
    expect(googleRefs.at(-1)).to.include({ googleEventId: "g-2" });
  });

  it("removes the Google copy when the appointment is cancelled, and re-creates it on restore", async () => {
    row = eventRow({ googleEventId: "g-1", status: "cancelled" });
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).to.deep.equal([`DELETE ${EVENTS_URL}/g-1`]);
    expect(googleRefs).to.deep.equal([{ id: "evt-1", googleEventId: null, googleLink: null }]);

    row!.status = "pending";
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls.at(-1)!.method).to.equal("POST");
  });

  it("does nothing when the owner hasn't connected Google Calendar", async () => {
    connected = false;
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls).to.be.empty;
  });

  it("skips (doesn't throw) when the owner must reconnect", async () => {
    accessTokenError = new HttpError("reconnect", 409, "GOOGLE_CALENDAR_RECONNECT_REQUIRED");
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(calls).to.be.empty;
  });

  it("never throws on a Google error", async () => {
    respond = () => new Response("boom", { status: 500 });
    await GoogleCalendarSyncSvc.syncEvent("evt-1");
    expect(googleRefs).to.be.empty;
  });

  it("runs a create and a quick edit one after another, so only one Google event is made", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let posts = 0;
    respond = (method) => {
      if (method === "POST") posts++;
      return new Response(JSON.stringify({ id: "g-1", htmlLink: "l" }), { status: 200 });
    };
    const realFind = (EventRepo as any).findRawById;
    let first = true;
    (EventRepo as any).findRawById = async (id: string) => {
      if (first) {
        first = false;
        await firstGate;
      }
      return realFind(id);
    };

    const a = GoogleCalendarSyncSvc.syncEvent("evt-1");
    const b = GoogleCalendarSyncSvc.syncEvent("evt-1");
    releaseFirst();
    await Promise.all([a, b]);
    expect(posts).to.equal(1);
    expect(calls.map((c) => c.method)).to.deep.equal(["POST", "PATCH"]);
  });

  it("deletes the Google copy of a deleted appointment and ignores one already gone", async () => {
    await GoogleCalendarSyncSvc.removeDeletedEvent({ id: "evt-1", userId: "owner-1", googleEventId: "g-1" });
    respond = () => new Response("gone", { status: 404 });
    await GoogleCalendarSyncSvc.removeDeletedEvent({ id: "evt-2", userId: "owner-1", googleEventId: "g-2" });
    await GoogleCalendarSyncSvc.removeDeletedEvent({ id: "evt-3", userId: "owner-1", googleEventId: null });
    expect(calls.map((c) => `${c.method} ${c.url}`)).to.deep.equal([`DELETE ${EVENTS_URL}/g-1`, `DELETE ${EVENTS_URL}/g-2`]);
  });

  describe("EventSvc hooks", () => {
    let synced: string[];
    let removed: string[];

    beforeEach(() => {
      synced = [];
      removed = [];
      restore.push(stash(GoogleCalendarSyncSvc as any, ["syncEvent", "removeDeletedEvent"]));
      (GoogleCalendarSyncSvc as any).syncEvent = async (id: string) => synced.push(id);
      (GoogleCalendarSyncSvc as any).removeDeletedEvent = async (e: { id: string }) => removed.push(e.id);
      (EventRepo as any).create = async () => eventRow({ id: "new-evt" });
      (EventRepo as any).updateById = async () => ({ count: 1 });
      (EventRepo as any).findById = async () => eventRow();
    });

    it("syncs after create", async () => {
      await EventSvc.create("org-1", "owner-1", { title: "Consultation", date_time: "2026-10-03T05:00:00.000Z" });
      expect(synced).to.deep.equal(["new-evt"]);
    });

    it("syncs edits, cancels and restores, but not bookkeeping-only updates", async () => {
      await EventSvc.updateById("evt-1", "org-1", "owner-1", "o@x.com", { title: "New title" });
      await EventSvc.updateById("evt-1", "org-1", "owner-1", "o@x.com", { status: "cancelled" });
      await EventSvc.updateById("evt-1", "org-1", "owner-1", "o@x.com", { last_reminder_sent_at: "2026-10-01T00:00:00Z" });
      await EventSvc.updateById("evt-1", "org-1", "owner-1", "o@x.com", { lawyer_acknowledged_at: "2026-10-01T00:00:00Z" });
      expect(synced).to.deep.equal(["evt-1", "evt-1"]);
    });

    it("removes the Google copy after a delete that actually deleted something", async () => {
      (EventRepo as any).deleteById = async () => ({ count: 1 });
      await EventSvc.deleteById("evt-1", "org-1", "owner-1");
      (EventRepo as any).deleteById = async () => ({ count: 0 });
      await EventSvc.deleteById("evt-1", "org-1", "someone-else");
      expect(removed).to.deep.equal(["evt-1"]);
    });
  });
});
