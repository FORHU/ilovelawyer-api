/** Two-way Google Calendar sync, scenario by scenario: appointments go app → Google through
 * EventSvc + GoogleCalendarSyncSvc, and Google edits come back through GoogleCalendarPullSvc.
 *
 * No live Postgres/Google: an in-memory appointment store stands in for EventRepo, and a fake
 * Google Calendar (events, PATCH-with-null semantics, deletions, syncTokens) answers the global
 * fetch — same monkeypatch idiom as test/avatar-and-google-calendar.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import EventSvc from "../src/services/event.service";
import GoogleCalendarPullSvc, { changesFromGoogle } from "../src/services/google-calendar-pull.service";
import GoogleCalendarSvc from "../src/services/google-calendar.service";
import CalendarWatchChannelSvc from "../src/services/calendar-watch-channel.service";
import CalendarWatchChannelCtrl from "../src/controllers/calendar-watch-channel.controller";
import { notesFromDescription, toGoogleEvent, whenSyncIdle } from "../src/services/google-calendar-sync.service";
import EventRepo from "../src/repositories/event.repository";
import AuthRepo from "../src/repositories/auth.repository";
import NotificationSvc from "../src/services/notification.service";
import * as tokenCrypto from "../src/utils/google-token-crypto";

const OWNER = "owner-1";
const ORG = "org-1";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

// The real token function, captured before the webhook tests swap it for a fixed-key one.
const realChannelToken = tokenCrypto.calendarChannelToken;

const tick = () => new Promise((r) => setTimeout(r, 5));

// ── Fake Google Calendar ────────────────────────────────────────────────────────────────────
type GEvent = Record<string, any> & { id: string; status: string; updated: string };

class FakeGoogle {
  events = new Map<string, GEvent>();
  private log: string[] = []; // event ids in change order; a syncToken is an index into it
  private nextId = 1;
  failWrites = false;
  calls: string[] = [];

  private touch(e: GEvent) {
    e.updated = new Date().toISOString();
    this.log.push(e.id);
  }

  /** Someone editing directly in Google Calendar. */
  edit(id: string, patch: Record<string, any>) {
    Object.assign(this.events.get(id)!, patch);
    this.touch(this.events.get(id)!);
  }

  /** Someone deleting directly in Google Calendar. */
  remove(id: string) {
    this.events.get(id)!.status = "cancelled";
    this.touch(this.events.get(id)!);
  }

  /** A personal event created in Google, not by the app. */
  addPersonal(summary: string) {
    const e: GEvent = { id: `personal-${this.nextId++}`, status: "confirmed", updated: "", summary, start: { dateTime: "2099-10-05T01:00:00.000Z" } };
    this.events.set(e.id, e);
    this.touch(e);
    return e;
  }

  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname.split("/events")[1] || "/"}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (method === "GET") {
      const syncToken = u.searchParams.get("syncToken");
      if (syncToken === "expired") return new Response("gone", { status: 410 });
      const ids = syncToken ? [...new Set(this.log.slice(Number(syncToken)))] : [...this.events.keys()];
      return json({ items: ids.map((id) => ({ ...this.events.get(id)! })), nextSyncToken: String(this.log.length) });
    }
    if (this.failWrites) return new Response("unavailable", { status: 503 });

    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST") {
      const e: GEvent = { ...body, id: `g-${this.nextId++}`, status: "confirmed", updated: "", htmlLink: "" };
      e.htmlLink = `https://calendar.google.com/event?eid=${e.id}`;
      this.events.set(e.id, e);
      this.touch(e);
      return json(e);
    }
    const id = decodeURIComponent(u.pathname.split("/events/")[1]);
    const existing = this.events.get(id);
    if (!existing || existing.status === "cancelled") return new Response("gone", { status: 410 });
    if (method === "DELETE") {
      this.remove(id);
      return new Response(null, { status: 204 });
    }
    // PATCH: null clears a field, anything else replaces it.
    for (const [k, v] of Object.entries(body)) {
      if (v === null) delete existing[k];
      else existing[k] = v;
    }
    this.touch(existing);
    return json(existing);
  }
}

// ── In-memory appointment store standing in for EventRepo ───────────────────────────────────
type Row = Record<string, any>;

describe("Two-way Google Calendar sync — scenarios", () => {
  let restore: (() => void)[];
  let rows: Map<string, Row>;
  let google: FakeGoogle;
  let connected: boolean;
  let syncToken: string | null;
  let nextRow: number;
  const realFetch = globalThis.fetch;

  const write = (id: string, data: Row) => {
    const row = rows.get(id);
    if (!row) return { count: 0 };
    Object.assign(row, data, { updatedAt: new Date() });
    return { count: 1 };
  };

  async function createInApp(overrides: Row = {}) {
    const event = await EventSvc.create(ORG, OWNER, {
      title: "Consultation",
      type: "Meeting",
      date_time: "2099-10-03T05:00:00.000Z",
      client_email: "client@example.com",
      notes: "Bring the contract",
      ...overrides,
    });
    await whenSyncIdle();
    return rows.get(event.id)!;
  }
  const editInApp = async (id: string, body: Row) => {
    await EventSvc.updateById(id, ORG, OWNER, "owner@x.com", body);
    await whenSyncIdle();
  };
  const poll = async () => {
    await GoogleCalendarPullSvc.syncUser(OWNER);
    await whenSyncIdle();
  };
  const googleCopy = (row: Row) => google.events.get(row.googleEventId)!;

  beforeEach(async () => {
    rows = new Map();
    google = new FakeGoogle();
    connected = true;
    syncToken = null;
    nextRow = 1;

    restore = [
      stash(EventRepo as any, [
        "create", "updateById", "findById", "findRawById", "deleteById",
        "setGoogleRef", "findByOwnerGoogleEventId", "applyGoogleChanges",
      ]),
      stash(AuthRepo as any, ["findGoogleCalendarTokens", "setGoogleCalendarSyncToken"]),
      stash(GoogleCalendarSvc as any, ["getAccessToken"]),
      stash(NotificationSvc as any, ["create"]),
    ];

    (EventRepo as any).create = async (organizationId: string, userId: string, data: Row) => {
      const row: Row = {
        id: `evt-${nextRow++}`, organizationId, userId, endDateTime: null, clientEmail: null, notes: null,
        status: "pending", type: "Meeting", googleEventId: null, googleLink: null, googleUpdatedAt: null,
        googleDirtyAt: null, lastReminderSentAt: null, createdAt: new Date(), updatedAt: new Date(),
      };
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
      rows.set(row.id, row);
      return { ...row };
    };
    (EventRepo as any).updateById = async (id: string, _o: string, _u: string, _e: string, data: Row) => write(id, data);
    (EventRepo as any).findById = async (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null);
    (EventRepo as any).findRawById = async (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null);
    (EventRepo as any).deleteById = async (id: string) => ({ count: rows.delete(id) ? 1 : 0 });
    (EventRepo as any).setGoogleRef = async (id: string, googleEventId: string | null, googleLink: string | null, googleUpdatedAt?: string | null) =>
      write(id, {
        googleEventId,
        googleLink,
        ...(googleUpdatedAt !== undefined ? { googleUpdatedAt: googleUpdatedAt ? new Date(googleUpdatedAt) : null, googleDirtyAt: null } : {}),
      });
    (EventRepo as any).findByOwnerGoogleEventId = async (userId: string, gid: string) =>
      [...rows.values()].find((r) => r.userId === userId && r.googleEventId === gid) ?? null;
    (EventRepo as any).applyGoogleChanges = async (id: string, data: Row) => write(id, data);

    (AuthRepo as any).findGoogleCalendarTokens = async () =>
      connected ? { googleAccessToken: "a", googleRefreshToken: "v1:enc", googleCalendarSyncToken: syncToken } : { googleAccessToken: null, googleRefreshToken: null, googleCalendarSyncToken: null };
    (AuthRepo as any).setGoogleCalendarSyncToken = async (_u: string, token: string | null) => {
      syncToken = token;
    };
    (GoogleCalendarSvc as any).getAccessToken = async () => "access-1";
    (NotificationSvc as any).create = async () => ({});
    globalThis.fetch = ((url: string, init?: RequestInit) => google.handle(String(url), init)) as typeof fetch;

    // Baseline poll right after connecting, as GoogleCalendarSyncQueue would do.
    await poll();
  });

  afterEach(() => {
    restore.forEach((r) => r());
    globalThis.fetch = realFetch;
  });

  // ── App → Google ──────────────────────────────────────────────────────────────────────────
  it("1. scheduled in the app → appears in Google, with notes and client but no guests", async () => {
    const row = await createInApp();
    const copy = googleCopy(row);
    expect(copy.summary).to.equal("Consultation");
    expect(copy.start.dateTime).to.equal("2099-10-03T05:00:00.000Z");
    expect(copy.end.dateTime).to.equal("2099-10-03T06:00:00.000Z");
    expect(copy.description).to.match(/^Bring the contract\n\n— ilovelawyer —\nType: Meeting\nClient: client@example\.com\n/);
    expect(copy).not.to.have.property("attendees");
    expect(copy.extendedProperties.private.ilovelawyerEventId).to.equal(row.id);
    expect(row.googleLink).to.equal(`https://calendar.google.com/event?eid=${row.googleEventId}`);
    expect(row.googleDirtyAt).to.equal(null);
  });

  it("2. edited in the app → the same Google event is updated", async () => {
    const row = await createInApp();
    const gid = row.googleEventId;
    await editInApp(row.id, { title: "Consultation (moved)", date_time: "2099-10-04T02:00:00.000Z" });
    expect(rows.get(row.id)!.googleEventId).to.equal(gid);
    expect(google.events.get(gid)!.summary).to.equal("Consultation (moved)");
    expect(google.events.get(gid)!.start.dateTime).to.equal("2099-10-04T02:00:00.000Z");
    expect(google.events.size).to.equal(1);
  });

  it("3. cancelled in the app → stays in Google, marked: 'Cancelled:' title, grey, free time", async () => {
    const row = await createInApp();
    await editInApp(row.id, { status: "cancelled" });
    const copy = googleCopy(rows.get(row.id)!);
    expect(copy.status).to.equal("confirmed");
    expect(copy.summary).to.equal("Cancelled: Consultation");
    expect(copy.colorId).to.equal("8");
    expect(copy.transparency).to.equal("transparent");
  });

  it("4. restored in the app → the same Google event is unmarked (title, colour, busy)", async () => {
    const row = await createInApp();
    const gid = row.googleEventId;
    await editInApp(row.id, { status: "cancelled" });
    await editInApp(row.id, { status: "pending" });
    expect(rows.get(row.id)!.googleEventId).to.equal(gid);
    const copy = google.events.get(gid)!;
    expect(copy.summary).to.equal("Consultation");
    expect(copy).not.to.have.property("colorId");
    expect(copy.transparency).to.equal("opaque");
  });

  it("5. deleted in the app → removed from Google", async () => {
    const row = await createInApp();
    await EventSvc.deleteById(row.id, ORG, OWNER);
    await whenSyncIdle();
    expect(google.events.get(row.googleEventId)!.status).to.equal("cancelled");
  });

  // ── Google → app ──────────────────────────────────────────────────────────────────────────
  it("6. title, time and notes edited in Google → the app follows on the next poll (new reminder for a new time)", async () => {
    const row = await createInApp();
    write(row.id, { lastReminderSentAt: new Date() });
    await tick();
    google.edit(row.googleEventId, {
      summary: "Consultation with Ms. Cruz",
      start: { dateTime: "2099-10-03T07:00:00.000Z" },
      end: { dateTime: "2099-10-03T08:30:00.000Z" },
      description: googleCopy(row).description.replace("Bring the contract", "Bring the contract and ID"),
    });
    await poll();
    const updated = rows.get(row.id)!;
    expect(updated.title).to.equal("Consultation with Ms. Cruz");
    expect(updated.dateTime.toISOString()).to.equal("2099-10-03T07:00:00.000Z");
    expect(updated.endDateTime.toISOString()).to.equal("2099-10-03T08:30:00.000Z");
    expect(updated.notes).to.equal("Bring the contract and ID");
    expect(updated.lastReminderSentAt).to.equal(null);
  });

  it("7. client and type edited in Google's description → ignored (app-owned)", async () => {
    const row = await createInApp();
    await tick();
    google.edit(row.googleEventId, {
      description: googleCopy(row).description.replace("client@example.com", "someone-else@example.com").replace("Type: Meeting", "Type: Hearing"),
    });
    await poll();
    expect(rows.get(row.id)!.clientEmail).to.equal("client@example.com");
    expect(rows.get(row.id)!.type).to.equal("Meeting");
    expect(rows.get(row.id)!.notes).to.equal("Bring the contract");
  });

  it("8. the sync's own writes don't bounce back (no extra writes or pushes after a poll)", async () => {
    const row = await createInApp();
    await editInApp(row.id, { notes: "Updated in the app" });
    const before = { ...rows.get(row.id)! };
    const writesBefore = google.calls.filter((c) => !c.startsWith("GET")).length;
    await poll();
    await poll();
    expect(rows.get(row.id)!.updatedAt).to.deep.equal(before.updatedAt);
    expect(google.calls.filter((c) => !c.startsWith("GET")).length).to.equal(writesBefore);
  });

  it("9. deleted in Google → cancelled in the app (not deleted); restoring makes a new Google event", async () => {
    const row = await createInApp();
    const oldGid = row.googleEventId;
    await tick();
    google.remove(oldGid);
    await poll();
    const cancelled = rows.get(row.id)!;
    expect(cancelled.status).to.equal("cancelled");
    expect(cancelled.googleEventId).to.equal(null);

    await editInApp(row.id, { status: "pending" });
    const restored = rows.get(row.id)!;
    expect(restored.googleEventId).to.be.a("string").and.not.equal(oldGid);
    expect(googleCopy(restored).summary).to.equal("Consultation");
  });

  it("10a. edited in both: the app's later edit wins even if its push failed at the time", async () => {
    const row = await createInApp();
    await tick();
    google.edit(row.googleEventId, { summary: "Google title" }); // earlier
    await tick();
    google.failWrites = true;
    await editInApp(row.id, { title: "App title" }); // later, but Google is down
    google.failWrites = false;
    expect(rows.get(row.id)!.googleDirtyAt).to.be.instanceOf(Date);

    await poll();
    expect(rows.get(row.id)!.title).to.equal("App title");
    expect(googleCopy(row).summary).to.equal("App title");
    expect(rows.get(row.id)!.googleDirtyAt).to.equal(null);
  });

  it("10b. edited in both: Google's later edit wins over an older app edit that never reached Google", async () => {
    const row = await createInApp();
    google.failWrites = true;
    await editInApp(row.id, { title: "App title" }); // earlier, push failed
    google.failWrites = false;
    await tick();
    google.edit(row.googleEventId, { summary: "Google title" }); // later
    await poll();
    expect(rows.get(row.id)!.title).to.equal("Google title");
    expect(rows.get(row.id)!.googleDirtyAt).to.equal(null);
  });

  it("11. a bookkeeping write (reminder sent) after a Google edit doesn't make the app 'win'", async () => {
    const row = await createInApp();
    await tick();
    google.edit(row.googleEventId, { summary: "Moved in Google" });
    await tick();
    write(row.id, { lastReminderSentAt: new Date() }); // bumps updatedAt, not googleDirtyAt
    await poll();
    expect(rows.get(row.id)!.title).to.equal("Moved in Google");
    expect(googleCopy(row).summary).to.equal("Moved in Google");
  });

  it("12. personal Google events are never imported", async () => {
    google.addPersonal("Dentist");
    await poll();
    expect(rows.size).to.equal(0);
  });

  it("13. title edited in Google on a cancelled appointment → title updates, it stays cancelled, marker not stored", async () => {
    const row = await createInApp();
    await editInApp(row.id, { status: "cancelled" });
    await tick();
    google.edit(row.googleEventId, { summary: "Cancelled: Consultation (Cruz)" });
    await poll();
    expect(rows.get(row.id)!.title).to.equal("Consultation (Cruz)");
    expect(rows.get(row.id)!.status).to.equal("cancelled");
  });

  it("14. an expired syncToken resets and the next poll takes a fresh baseline", async () => {
    const row = await createInApp();
    syncToken = "expired";
    await poll();
    expect(syncToken).to.equal(null);
    await tick();
    google.edit(row.googleEventId, { summary: "After the reset" });
    await poll();
    expect(rows.get(row.id)!.title).to.equal("After the reset");
    expect(syncToken).to.be.a("string");
  });

  it("15. not connected → nothing is sent to or read from Google", async () => {
    connected = false;
    google.calls = [];
    await createInApp();
    await poll();
    expect(google.calls).to.be.empty;
  });

  it("16. deleted in Google, then edited in the app → a new Google copy is made, nothing lost", async () => {
    const row = await createInApp();
    const oldGid = row.googleEventId;
    google.remove(oldGid); // the app hasn't polled yet
    await editInApp(row.id, { notes: "New notes" });
    const fresh = rows.get(row.id)!;
    expect(fresh.googleEventId).to.be.a("string").and.not.equal(oldGid);
    expect(googleCopy(fresh).description).to.match(/^New notes/);
  });
});

describe("Google Calendar sync helpers", () => {
  it("reads notes from a description, with or without the app's marker, and from the one-way format", () => {
    expect(notesFromDescription("Hello\n\n— ilovelawyer —\nType: Meeting\nClient: c@x.com\nfooter")).to.equal("Hello");
    expect(notesFromDescription("— ilovelawyer —\nType: Meeting")).to.equal(null);
    expect(notesFromDescription("[type:meeting]\nOld notes\nClient: c@x.com\nScheduled in ilovelawyer")).to.equal("Old notes");
    expect(notesFromDescription("User replaced everything")).to.equal("User replaced everything");
    expect(notesFromDescription(undefined)).to.equal(null);
  });

  it("leaves times alone for an all-day Google event", () => {
    const event: any = { title: "T", dateTime: new Date("2099-10-03T05:00:00Z"), endDateTime: null, notes: null };
    expect(changesFromGoogle({ id: "g", summary: "T", start: { date: "2099-10-03" }, end: { date: "2099-10-04" } }, event)).to.deep.equal({});
  });

  it("marks a cancelled appointment on Google and unmarks it when active", () => {
    const base: any = { id: "e", title: "T", type: "Meeting", dateTime: new Date("2099-10-03T05:00:00Z"), endDateTime: null, notes: null, clientEmail: null };
    expect(toGoogleEvent({ ...base, status: "cancelled" })).to.include({ summary: "Cancelled: T", colorId: "8", transparency: "transparent" });
    expect(toGoogleEvent({ ...base, status: "pending" })).to.include({ summary: "T", colorId: null, transparency: "opaque" });
  });
});

describe("Calendar webhook", () => {
  let restore: (() => void)[];
  let pulled: string[];
  const key = Buffer.alloc(32, 7).toString("base64");

  beforeEach(() => {
    pulled = [];
    restore = [
      stash(CalendarWatchChannelSvc as any, ["findByChannelId"]),
      stash(GoogleCalendarPullSvc as any, ["syncUser"]),
      stash(tokenCrypto as any, ["calendarChannelToken"]),
    ];
    (CalendarWatchChannelSvc as any).findByChannelId = async (id: string) => ({ userId: "owner-1", channelId: id });
    (GoogleCalendarPullSvc as any).syncUser = async (userId: string) => pulled.push(userId);
    // Bind the webhook's token check to a fixed key (no GOOGLE_TOKEN_ENC_KEY needed in tests).
    (tokenCrypto as any).calendarChannelToken = (id: string) => realChannelToken(id, key);
  });
  afterEach(() => restore.forEach((r) => r()));

  async function notify(headers: Record<string, string>) {
    let body = "";
    const res = { status: () => res, send: (b: string) => ((body = b), res) } as unknown as ExpressResponse;
    await CalendarWatchChannelCtrl.handleWebhook({ headers } as unknown as ExpressRequest, res);
    return body;
  }

  it("pulls for a notification carrying the channel's token, and ignores one without it", async () => {
    const good = tokenCrypto.calendarChannelToken("ch-1");
    expect(await notify({ "x-goog-channel-id": "ch-1", "x-goog-channel-token": good!, "x-goog-resource-state": "exists" })).to.equal("Queued");
    expect(await notify({ "x-goog-channel-id": "ch-1", "x-goog-channel-token": "forged", "x-goog-resource-state": "exists" })).to.equal("Ignored");
    expect(await notify({ "x-goog-channel-id": "ch-1", "x-goog-resource-state": "exists" })).to.equal("Ignored");
    expect(pulled).to.deep.equal(["owner-1"]);
  });

  it("derives a stable per-channel token, different per channel and per key", () => {
    const a = realChannelToken("ch-1", key);
    expect(realChannelToken("ch-1", key)).to.equal(a);
    expect(realChannelToken("ch-2", key)).to.not.equal(a);
    expect(realChannelToken("ch-1", Buffer.alloc(32, 9).toString("base64"))).to.not.equal(a);
  });
});

