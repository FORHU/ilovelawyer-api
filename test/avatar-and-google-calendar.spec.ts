/** AvatarSvc (Google photo at signup, upload, remove) and GoogleCalendarSvc (connect, refresh,
 * disconnect), plus the refresh-token encryption they rely on.
 *
 * No live Postgres/S3/Google: AuthRepo, FilesRepo, FilesSvc, CalendarWatchChannelRepo and the
 * global fetch are monkeypatched, same idiom as test/auth-google.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import crypto from "crypto";
import AvatarSvc, { detectImageType, googlePhotoUrl } from "../src/services/avatar.service";
import GoogleCalendarSvc, { GOOGLE_CALENDAR_SCOPE } from "../src/services/google-calendar.service";
import AuthRepo from "../src/repositories/auth.repository";
import FilesRepo from "../src/repositories/files.repository";
import FilesSvc from "../src/services/files.service";
import CalendarWatchChannelRepo from "../src/repositories/calendar-watch-channel.repository";
import * as cryptoModule from "../src/utils/google-token-crypto";
import HttpError from "../src/utils/http-error";
import { AVATAR_MAX_BYTES } from "../src/constants";
import prisma from "../src/lib/prisma";

const KEY = crypto.randomBytes(32).toString("base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(100)]);

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function expectHttpError(promise: Promise<unknown>, status: number, code?: string) {
  try {
    await promise;
  } catch (err) {
    expect(err).to.be.instanceOf(HttpError);
    expect((err as HttpError).statusCode).to.equal(status);
    if (code !== undefined) expect((err as HttpError).code).to.equal(code);
    return;
  }
  throw new Error(`expected HttpError ${status}`);
}

type FetchCall = { url: string; init?: RequestInit };

describe("google-token-crypto", () => {
  it("round-trips a token and never stores it in plain text", () => {
    const stored = cryptoModule.encryptGoogleToken("1//refresh-token", KEY);
    expect(stored).to.match(/^v1:/);
    expect(stored).not.to.include("refresh-token");
    expect(cryptoModule.decryptGoogleToken(stored, KEY)).to.equal("1//refresh-token");
  });

  it("returns null for a different key, tampering or an unknown format", () => {
    const stored = cryptoModule.encryptGoogleToken("secret", KEY);
    expect(cryptoModule.decryptGoogleToken(stored, crypto.randomBytes(32).toString("base64"))).to.equal(null);
    const parts = stored.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(cryptoModule.decryptGoogleToken(parts.join(":"), KEY)).to.equal(null);
    expect(cryptoModule.decryptGoogleToken("plain-token", KEY)).to.equal(null);
  });

  it("refuses to encrypt without a valid key", () => {
    expect(() => cryptoModule.encryptGoogleToken("x", "too-short")).to.throw();
  });
});

describe("AvatarSvc", () => {
  let restore: (() => void)[];
  let uploads: { name: string; mime: string }[];
  let markedForDeletion: string[];
  let avatarIfEmpty: boolean;
  let setAvatarCalls: (string | null)[];
  let currentAvatar: { id: string; s3Key: string } | null;
  let fetchCalls: FetchCall[];
  let fetchResponse: () => Response;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    uploads = [];
    markedForDeletion = [];
    avatarIfEmpty = true;
    setAvatarCalls = [];
    currentAvatar = null;
    fetchCalls = [];
    fetchResponse = () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });

    restore = [
      stash(FilesSvc as any, ["upload"]),
      stash(FilesRepo as any, ["markForDeletion"]),
      stash(AuthRepo as any, ["setAvatarIfEmpty", "setAvatar", "findAvatarFile"]),
    ];
    (FilesSvc as any).upload = async (name: string, _buf: Buffer, mime: string) => {
      uploads.push({ name, mime });
      return { id: `file-${uploads.length}` };
    };
    (FilesRepo as any).markForDeletion = async (id: string) => markedForDeletion.push(id);
    (AuthRepo as any).setAvatarIfEmpty = async () => avatarIfEmpty;
    (AuthRepo as any).setAvatar = async (_userId: string, fileId: string | null) => {
      setAvatarCalls.push(fileId);
      return { id: "user-1", avatarUrl: fileId ? "/files/token" : null };
    };
    (AuthRepo as any).findAvatarFile = async () => currentAvatar;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return fetchResponse();
    }) as typeof fetch;
  });

  afterEach(() => {
    restore.forEach((r) => r());
    globalThis.fetch = realFetch;
  });

  it("detects JPEG, PNG and WebP by content and nothing else", () => {
    expect(detectImageType(JPEG)?.mime).to.equal("image/jpeg");
    expect(detectImageType(PNG)?.mime).to.equal("image/png");
    expect(detectImageType(WEBP)?.mime).to.equal("image/webp");
    expect(detectImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).to.equal(null);
    expect(detectImageType(Buffer.from("GIF89a"))).to.equal(null);
  });

  it("only accepts https googleusercontent.com photo URLs, resized to 256px", () => {
    expect(googlePhotoUrl("https://lh3.googleusercontent.com/a/ACg8oc=s96-c")).to.equal("https://lh3.googleusercontent.com/a/ACg8oc=s256-c");
    expect(googlePhotoUrl("https://lh3.googleusercontent.com/a/ACg8oc")).to.equal("https://lh3.googleusercontent.com/a/ACg8oc=s256-c");
    expect(googlePhotoUrl("http://lh3.googleusercontent.com/a/x")).to.equal(null);
    expect(googlePhotoUrl("https://evil.com/googleusercontent.com/a")).to.equal(null);
    expect(googlePhotoUrl("https://googleusercontent.com.evil.com/a")).to.equal(null);
    expect(googlePhotoUrl("not a url")).to.equal(null);
  });

  describe("importGooglePhoto", () => {
    it("copies the Google photo into S3 and sets it as the avatar", async () => {
      await AvatarSvc.importGooglePhoto("user-1", "https://lh3.googleusercontent.com/a/x=s96-c");
      expect(fetchCalls.map((c) => c.url)).to.deep.equal(["https://lh3.googleusercontent.com/a/x=s256-c"]);
      expect(uploads).to.deep.equal([{ name: "google-photo.jpg", mime: "image/jpeg" }]);
      expect(markedForDeletion).to.be.empty;
    });

    it("does nothing without a picture or for a non-Google host", async () => {
      await AvatarSvc.importGooglePhoto("user-1", undefined);
      await AvatarSvc.importGooglePhoto("user-1", "https://evil.com/a.jpg");
      expect(fetchCalls).to.be.empty;
      expect(uploads).to.be.empty;
    });

    it("never throws: a failed download, a non-image or an oversized photo leaves initials", async () => {
      fetchResponse = () => new Response("nope", { status: 404 });
      await AvatarSvc.importGooglePhoto("user-1", "https://lh3.googleusercontent.com/a/x");
      fetchResponse = () => new Response("<html>", { status: 200 });
      await AvatarSvc.importGooglePhoto("user-1", "https://lh3.googleusercontent.com/a/x");
      fetchResponse = () => new Response(Buffer.concat([JPEG, Buffer.alloc(AVATAR_MAX_BYTES)]), { status: 200 });
      await AvatarSvc.importGooglePhoto("user-1", "https://lh3.googleusercontent.com/a/x");
      expect(uploads).to.be.empty;
    });

    it("keeps an avatar the user set meanwhile and discards the Google copy", async () => {
      avatarIfEmpty = false;
      await AvatarSvc.importGooglePhoto("user-1", "https://lh3.googleusercontent.com/a/x");
      expect(markedForDeletion).to.deep.equal(["file-1"]);
    });
  });

  describe("setAvatar / removeAvatar", () => {
    it("stores an uploaded PNG and soft-deletes the previous avatar", async () => {
      currentAvatar = { id: "old-file", s3Key: "k" };
      const user = await AvatarSvc.setAvatar("user-1", PNG);
      expect(uploads).to.deep.equal([{ name: "avatar.png", mime: "image/png" }]);
      expect(setAvatarCalls).to.deep.equal(["file-1"]);
      expect(markedForDeletion).to.deep.equal(["old-file"]);
      expect(user).to.include({ avatarUrl: "/files/token" });
    });

    it("rejects a non-image, an empty body and an oversized image without uploading", async () => {
      await expectHttpError(AvatarSvc.setAvatar("user-1", Buffer.from("<svg/>")), 400);
      await expectHttpError(AvatarSvc.setAvatar("user-1", Buffer.alloc(0)), 400);
      await expectHttpError(AvatarSvc.setAvatar("user-1", Buffer.concat([JPEG, Buffer.alloc(AVATAR_MAX_BYTES)])), 413);
      expect(uploads).to.be.empty;
    });

    it("remove goes back to initials and soft-deletes the file", async () => {
      currentAvatar = { id: "old-file", s3Key: "k" };
      const user = await AvatarSvc.removeAvatar("user-1");
      expect(setAvatarCalls).to.deep.equal([null]);
      expect(markedForDeletion).to.deep.equal(["old-file"]);
      expect(user).to.include({ avatarUrl: null });
    });
  });
});

describe("GoogleCalendarSvc", () => {
  let restore: (() => void)[];
  let stored: { googleAccessToken: string | null; googleRefreshToken: string | null } | null;
  let saved: { accessToken: string; encryptedRefreshToken?: string }[];
  let cleared: number;
  let updatedAccess: string[];
  let channel: { channelId: string; resourceId: string } | null;
  let channelsDeleted: number;
  let fetchCalls: FetchCall[];
  let tokenResponse: { status: number; body: object };
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    stored = null;
    saved = [];
    cleared = 0;
    updatedAccess = [];
    channel = null;
    channelsDeleted = 0;
    fetchCalls = [];
    tokenResponse = { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", scope: `openid ${GOOGLE_CALENDAR_SCOPE}` } };

    restore = [
      stash(AuthRepo as any, [
        "findGoogleCalendarTokens",
        "setGoogleCalendarTokens",
        "clearGoogleCalendarTokens",
        "updateGoogleAccessToken",
        "findById",
      ]),
      stash(CalendarWatchChannelRepo as any, ["findForUser", "deleteForUser"]),
      stash(cryptoModule as any, ["isGoogleTokenEncryptionConfigured", "encryptGoogleToken", "decryptGoogleToken"]),
    ];
    (AuthRepo as any).findGoogleCalendarTokens = async () => stored;
    (AuthRepo as any).setGoogleCalendarTokens = async (_id: string, data: any) => saved.push(data);
    (AuthRepo as any).clearGoogleCalendarTokens = async () => cleared++;
    (AuthRepo as any).updateGoogleAccessToken = async (_id: string, token: string) => updatedAccess.push(token);
    (AuthRepo as any).findById = async (id: string) => ({ id });
    (CalendarWatchChannelRepo as any).findForUser = async () => channel;
    (CalendarWatchChannelRepo as any).deleteForUser = async () => channelsDeleted++;
    (cryptoModule as any).isGoogleTokenEncryptionConfigured = () => true;
    (cryptoModule as any).encryptGoogleToken = (plain: string) => `enc(${plain})`;
    (cryptoModule as any).decryptGoogleToken = (s: string) => (s.startsWith("enc(") ? s.slice(4, -1) : null);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify(tokenResponse.body), { status: tokenResponse.status });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    restore.forEach((r) => r());
    globalThis.fetch = realFetch;
  });

  describe("connect", () => {
    it("exchanges the popup code and stores the refresh token encrypted", async () => {
      await GoogleCalendarSvc.connect("user-1", "code-1");
      const body = new URLSearchParams(String(fetchCalls[0].init?.body));
      expect(body.get("code")).to.equal("code-1");
      expect(body.get("redirect_uri")).to.equal("postmessage");
      expect(body.get("grant_type")).to.equal("authorization_code");
      expect(saved).to.deep.equal([{ accessToken: "access-1", encryptedRefreshToken: "enc(refresh-1)" }]);
    });

    it("refuses when Calendar access was unticked in the consent screen", async () => {
      tokenResponse.body = { access_token: "a", refresh_token: "r", scope: "openid email" };
      await expectHttpError(GoogleCalendarSvc.connect("user-1", "code"), 400, "GOOGLE_CALENDAR_SCOPE_MISSING");
      expect(saved).to.be.empty;
    });

    it("keeps the stored refresh token when a reconnect returns none", async () => {
      stored = { googleAccessToken: "old", googleRefreshToken: "enc(old-refresh)" };
      tokenResponse.body = { access_token: "access-2", scope: GOOGLE_CALENDAR_SCOPE };
      await GoogleCalendarSvc.connect("user-1", "code");
      expect(saved).to.deep.equal([{ accessToken: "access-2", encryptedRefreshToken: undefined }]);
    });

    it("refuses without a refresh token when none is stored, a rejected code, or no encryption key", async () => {
      tokenResponse.body = { access_token: "a", scope: GOOGLE_CALENDAR_SCOPE };
      await expectHttpError(GoogleCalendarSvc.connect("user-1", "code"), 400);
      tokenResponse = { status: 400, body: { error: "invalid_grant" } };
      await expectHttpError(GoogleCalendarSvc.connect("user-1", "code"), 400);
      (cryptoModule as any).isGoogleTokenEncryptionConfigured = () => false;
      await expectHttpError(GoogleCalendarSvc.connect("user-1", "code"), 503);
      expect(saved).to.be.empty;
    });
  });

  describe("getAccessToken", () => {
    it("mints a fresh access token from the decrypted refresh token and saves it", async () => {
      stored = { googleAccessToken: null, googleRefreshToken: "enc(refresh-1)" };
      expect(await GoogleCalendarSvc.getAccessToken("user-1")).to.equal("access-1");
      expect(new URLSearchParams(String(fetchCalls[0].init?.body)).get("refresh_token")).to.equal("refresh-1");
      expect(updatedAccess).to.deep.equal(["access-1"]);
    });

    it("clears both tokens and asks to reconnect on invalid_grant", async () => {
      stored = { googleAccessToken: "a", googleRefreshToken: "enc(revoked)" };
      tokenResponse = { status: 400, body: { error: "invalid_grant" } };
      await expectHttpError(GoogleCalendarSvc.getAccessToken("user-1"), 409, "GOOGLE_CALENDAR_RECONNECT_REQUIRED");
      expect(cleared).to.equal(1);
    });

    it("clears an undecryptable token the same way", async () => {
      stored = { googleAccessToken: null, googleRefreshToken: "garbage" };
      await expectHttpError(GoogleCalendarSvc.getAccessToken("user-1"), 409, "GOOGLE_CALENDAR_RECONNECT_REQUIRED");
      expect(cleared).to.equal(1);
      expect(fetchCalls).to.be.empty;
    });

    it("keeps the token on a transient Google failure", async () => {
      stored = { googleAccessToken: null, googleRefreshToken: "enc(refresh-1)" };
      tokenResponse = { status: 500, body: { error: "backend_error" } };
      await expectHttpError(GoogleCalendarSvc.getAccessToken("user-1"), 502);
      expect(cleared).to.equal(0);
    });

    it("reports not connected", async () => {
      await expectHttpError(GoogleCalendarSvc.getAccessToken("user-1"), 409, "GOOGLE_CALENDAR_NOT_CONNECTED");
    });
  });

  it("disconnect stops the watch, revokes the refresh token and clears local state", async () => {
    stored = { googleAccessToken: "access-1", googleRefreshToken: "enc(refresh-1)" };
    channel = { channelId: "ch-1", resourceId: "res-1" };
    await GoogleCalendarSvc.disconnect("user-1");

    const urls = fetchCalls.map((c) => c.url);
    expect(urls).to.deep.equal([
      "https://www.googleapis.com/calendar/v3/channels/stop",
      "https://oauth2.googleapis.com/revoke",
    ]);
    expect(new URLSearchParams(String(fetchCalls[1].init?.body)).get("token")).to.equal("refresh-1");
    expect(channelsDeleted).to.equal(1);
    expect(cleared).to.equal(1);
  });

  it("disconnect still clears local state when Google is unreachable", async () => {
    stored = { googleAccessToken: "access-1", googleRefreshToken: "enc(refresh-1)" };
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await GoogleCalendarSvc.disconnect("user-1");
    expect(cleared).to.equal(1);
  });
});

describe("AuthRepo public user shape", () => {
  let restore: () => void;
  const realFindUnique = (prisma.user as any).findUnique;

  beforeEach(() => {
    restore = () => ((prisma.user as any).findUnique = realFindUnique);
  });
  afterEach(() => restore());

  it("exposes avatarUrl and googleCalendarConnected, never the token or the S3 key", async () => {
    (prisma.user as any).findUnique = async () => ({
      id: "user-1",
      provider: null,
      password: null,
      avatar: { s3Key: "abc-avatar.png" },
      googleRefreshToken: "v1:secret",
    });
    const user = (await AuthRepo.findById("user-1")) as Record<string, unknown>;
    expect(user.avatarUrl).to.match(/^\/files\/[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(user.googleCalendarConnected).to.equal(true);
    expect(user).not.to.have.any.keys("avatar", "googleRefreshToken", "password");
    expect(JSON.stringify(user)).not.to.include("secret");
  });

  it("returns null avatarUrl (initials) and false when nothing is set", async () => {
    (prisma.user as any).findUnique = async () => ({ id: "user-1", provider: null, password: "h", avatar: null, googleRefreshToken: null });
    expect(await AuthRepo.findById("user-1")).to.include({ avatarUrl: null, googleCalendarConnected: false });
  });

  it("gives the same avatar URL for the whole hour, so /me refetches don't re-download it", async () => {
    (prisma.user as any).findUnique = async () => ({ id: "user-1", provider: null, password: null, avatar: { s3Key: "k.png" } });
    const a = ((await AuthRepo.findById("user-1")) as any).avatarUrl;
    const b = ((await AuthRepo.findById("user-1")) as any).avatarUrl;
    expect(a).to.equal(b);
  });
});
