/** GmailConnectionSvc: connect, refresh and disconnect of the client app's read-only Gmail grant
 * (EPIC #982, #983). No live Postgres or Google: AuthRepo, the token crypto and the global fetch
 * are monkeypatched, same idiom as test/avatar-and-google-calendar.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import GmailConnectionSvc, { GMAIL_READONLY_SCOPE } from "../src/services/gmail-connection.service";
import AuthRepo from "../src/repositories/auth.repository";
import * as cryptoModule from "../src/utils/google-token-crypto";
import HttpError from "../src/utils/http-error";

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

describe("GmailConnectionSvc", () => {
  let restore: (() => void)[];
  let stored: { gmailAccessToken: string | null; gmailRefreshToken: string | null; gmailEmail: string | null } | null;
  let saved: { accessToken: string; encryptedRefreshToken?: string; email: string }[];
  let cleared: number;
  let updatedAccess: string[];
  let fetchCalls: FetchCall[];
  let tokenResponse: { status: number; body: object };
  let profileResponse: { status: number; body: object };
  let revokeFails: boolean;
  let encryptionConfigured: boolean;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    stored = null;
    saved = [];
    cleared = 0;
    updatedAccess = [];
    fetchCalls = [];
    revokeFails = false;
    encryptionConfigured = true;
    tokenResponse = { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", scope: `openid ${GMAIL_READONLY_SCOPE}` } };
    profileResponse = { status: 200, body: { emailAddress: "client@gmail.com" } };

    restore = [
      stash(AuthRepo as any, ["findGmailTokens", "setGmailTokens", "clearGmailTokens", "updateGmailAccessToken", "findById"]),
      stash(cryptoModule as any, ["isGoogleTokenEncryptionConfigured", "encryptGoogleToken", "decryptGoogleToken"]),
    ];
    (AuthRepo as any).findGmailTokens = async () => stored;
    (AuthRepo as any).setGmailTokens = async (_id: string, data: any) => saved.push(data);
    (AuthRepo as any).clearGmailTokens = async () => cleared++;
    (AuthRepo as any).updateGmailAccessToken = async (_id: string, token: string) => updatedAccess.push(token);
    (AuthRepo as any).findById = async (id: string) => ({ id });
    (cryptoModule as any).isGoogleTokenEncryptionConfigured = () => encryptionConfigured;
    (cryptoModule as any).encryptGoogleToken = (plain: string) => `enc(${plain})`;
    (cryptoModule as any).decryptGoogleToken = (s: string) => (s.startsWith("enc(") ? s.slice(4, -1) : null);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes("/token")) return new Response(JSON.stringify(tokenResponse.body), { status: tokenResponse.status });
      if (String(url).includes("/profile")) return new Response(JSON.stringify(profileResponse.body), { status: profileResponse.status });
      if (String(url).includes("/revoke") && revokeFails) throw new Error("network down");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    restore.forEach((r) => r());
    globalThis.fetch = realFetch;
  });

  describe("connect", () => {
    it("exchanges the popup code, reads the mailbox address and stores the refresh token encrypted", async () => {
      await GmailConnectionSvc.connect("user-1", "code-1");
      const body = new URLSearchParams(String(fetchCalls[0].init?.body));
      expect(body.get("code")).to.equal("code-1");
      expect(body.get("redirect_uri")).to.equal("postmessage");
      expect(body.get("grant_type")).to.equal("authorization_code");
      expect(fetchCalls[1].url).to.include("/gmail/v1/users/me/profile");
      expect((fetchCalls[1].init?.headers as Record<string, string>).Authorization).to.equal("Bearer access-1");
      expect(saved).to.deep.equal([{ accessToken: "access-1", encryptedRefreshToken: "enc(refresh-1)", email: "client@gmail.com" }]);
    });

    it("refuses when Gmail access was unticked in the consent screen", async () => {
      tokenResponse.body = { access_token: "a", refresh_token: "r", scope: "openid email" };
      await expectHttpError(GmailConnectionSvc.connect("user-1", "code"), 400, "GMAIL_SCOPE_MISSING");
      expect(saved).to.be.empty;
    });

    it("revokes the new grant and asks for a fresh consent when no refresh token comes back and none is stored", async () => {
      tokenResponse.body = { access_token: "a", scope: GMAIL_READONLY_SCOPE };
      await expectHttpError(GmailConnectionSvc.connect("user-1", "code"), 400, "GMAIL_CONSENT_REQUIRED");
      const revoke = fetchCalls.find((c) => c.url.includes("/revoke"));
      expect(new URLSearchParams(String(revoke?.init?.body)).get("token")).to.equal("a");
      expect(saved).to.be.empty;
    });

    it("never pairs the stored refresh token with a different mailbox", async () => {
      stored = { gmailAccessToken: "old", gmailRefreshToken: "enc(refresh-a)", gmailEmail: "a@gmail.com" };
      tokenResponse.body = { access_token: "access-b", scope: GMAIL_READONLY_SCOPE };
      profileResponse = { status: 200, body: { emailAddress: "b@gmail.com" } };
      await expectHttpError(GmailConnectionSvc.connect("user-1", "code"), 400, "GMAIL_CONSENT_REQUIRED");
      const revoked = fetchCalls.filter((c) => c.url.includes("/revoke")).map((c) => new URLSearchParams(String(c.init?.body)).get("token"));
      expect(revoked).to.deep.equal(["access-b"]);
      expect(saved).to.be.empty;
    });

    it("ends the old mailbox's grant when switching to another account", async () => {
      stored = { gmailAccessToken: "old", gmailRefreshToken: "enc(refresh-a)", gmailEmail: "a@gmail.com" };
      profileResponse = { status: 200, body: { emailAddress: "b@gmail.com" } };
      await GmailConnectionSvc.connect("user-1", "code");
      const revoked = fetchCalls.filter((c) => c.url.includes("/revoke")).map((c) => new URLSearchParams(String(c.init?.body)).get("token"));
      expect(revoked).to.deep.equal(["refresh-a"]);
      expect(saved).to.deep.equal([{ accessToken: "access-1", encryptedRefreshToken: "enc(refresh-1)", email: "b@gmail.com" }]);
    });

    it("keeps the stored refresh token on a reconnect that returns none", async () => {
      stored = { gmailAccessToken: "old", gmailRefreshToken: "enc(refresh-0)", gmailEmail: "Client@Gmail.com" };
      tokenResponse.body = { access_token: "access-2", scope: GMAIL_READONLY_SCOPE };
      await GmailConnectionSvc.connect("user-1", "code");
      expect(saved).to.deep.equal([{ accessToken: "access-2", encryptedRefreshToken: undefined, email: "client@gmail.com" }]);
    });

    it("answers 503 when token encryption isn't configured, before calling Google", async () => {
      encryptionConfigured = false;
      await expectHttpError(GmailConnectionSvc.connect("user-1", "code"), 503, "GMAIL_UNAVAILABLE");
      expect(fetchCalls).to.be.empty;
    });

    it("answers 502 and stores nothing when the Gmail profile can't be read", async () => {
      profileResponse = { status: 500, body: {} };
      await expectHttpError(GmailConnectionSvc.connect("user-1", "code"), 502);
      expect(saved).to.be.empty;
    });
  });

  describe("refreshAccessToken", () => {
    it("mints and saves a fresh access token", async () => {
      stored = { gmailAccessToken: "old", gmailRefreshToken: "enc(refresh-1)", gmailEmail: "x@gmail.com" };
      tokenResponse.body = { access_token: "fresh" };
      expect(await GmailConnectionSvc.refreshAccessToken("user-1")).to.equal("fresh");
      expect(new URLSearchParams(String(fetchCalls[0].init?.body)).get("refresh_token")).to.equal("refresh-1");
      expect(updatedAccess).to.deep.equal(["fresh"]);
    });

    it("answers 409 GMAIL_NOT_CONNECTED with nothing stored", async () => {
      await expectHttpError(GmailConnectionSvc.refreshAccessToken("user-1"), 409, "GMAIL_NOT_CONNECTED");
    });

    it("clears the columns and asks for a reconnect when Google says invalid_grant", async () => {
      stored = { gmailAccessToken: "old", gmailRefreshToken: "enc(refresh-1)", gmailEmail: "x@gmail.com" };
      tokenResponse = { status: 400, body: { error: "invalid_grant" } };
      await expectHttpError(GmailConnectionSvc.refreshAccessToken("user-1"), 409, "GMAIL_RECONNECT_REQUIRED");
      expect(cleared).to.equal(1);
    });

    it("clears the columns when the stored token can't be decrypted", async () => {
      stored = { gmailAccessToken: null, gmailRefreshToken: "garbage", gmailEmail: null };
      await expectHttpError(GmailConnectionSvc.refreshAccessToken("user-1"), 409, "GMAIL_RECONNECT_REQUIRED");
      expect(cleared).to.equal(1);
      expect(fetchCalls).to.be.empty;
    });

    it("revokes the grant with the last access token when the refresh token can't be decrypted", async () => {
      stored = { gmailAccessToken: "last-access", gmailRefreshToken: "garbage", gmailEmail: null };
      await expectHttpError(GmailConnectionSvc.refreshAccessToken("user-1"), 409, "GMAIL_RECONNECT_REQUIRED");
      expect(fetchCalls.map((c) => c.url)).to.deep.equal(["https://oauth2.googleapis.com/revoke"]);
      expect(new URLSearchParams(String(fetchCalls[0].init?.body)).get("token")).to.equal("last-access");
      expect(cleared).to.equal(1);
    });

    it("keeps the token on a temporary Google failure", async () => {
      stored = { gmailAccessToken: "old", gmailRefreshToken: "enc(refresh-1)", gmailEmail: "x@gmail.com" };
      tokenResponse = { status: 503, body: {} };
      await expectHttpError(GmailConnectionSvc.refreshAccessToken("user-1"), 502);
      expect(cleared).to.equal(0);
    });
  });

  describe("forget", () => {
    it("revokes and clears the grant, returning the reconnect error", async () => {
      stored = { gmailAccessToken: "a", gmailRefreshToken: "enc(refresh-1)", gmailEmail: "x@gmail.com" };
      const err = await GmailConnectionSvc.forget("user-1");
      expect(err.code).to.equal("GMAIL_RECONNECT_REQUIRED");
      expect(fetchCalls.some((c) => c.url.includes("/revoke"))).to.equal(true);
      expect(cleared).to.equal(1);
    });
  });

  describe("disconnect", () => {
    it("revokes the refresh token at Google and clears the columns", async () => {
      stored = { gmailAccessToken: "a", gmailRefreshToken: "enc(refresh-1)", gmailEmail: "x@gmail.com" };
      await GmailConnectionSvc.disconnect("user-1");
      const revoke = fetchCalls.find((c) => c.url.includes("/revoke"));
      expect(new URLSearchParams(String(revoke?.init?.body)).get("token")).to.equal("refresh-1");
      expect(cleared).to.equal(1);
    });

    it("still clears local state when Google can't be reached", async () => {
      stored = { gmailAccessToken: "a", gmailRefreshToken: "enc(refresh-1)", gmailEmail: "x@gmail.com" };
      revokeFails = true;
      await GmailConnectionSvc.disconnect("user-1");
      expect(cleared).to.equal(1);
    });
  });
});
