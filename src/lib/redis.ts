import { createClient } from "redis";
import { REDIS_URL } from "../config";

const client = createClient({
  url: REDIS_URL ?? "redis://localhost:6379",
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
});

client.connect().catch(() => {});
client.on("error", () => {});

export const redis = {
  async ping(): Promise<boolean> {
    if (!client.isReady) return false;
    try {
      return (await client.ping()) === "PONG";
    } catch {
      return false;
    }
  },

  async get<T>(key: string): Promise<T | null> {
    if (!client.isReady) return null;
    try {
      const raw = await client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!client.isReady) return;
    try {
      await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch {}
  },

  /** Monotonic counter for cache-busting a family of keys at once (see `admin.service.ts`). */
  async incr(key: string): Promise<number> {
    if (!client.isReady) return 0;
    try {
      return await client.incr(key);
    } catch {
      return 0;
    }
  },

  /** Sets `key` only if it isn't there yet (SET NX EX). True when this call set it, false when it
   * already existed, null when Redis can't tell (not reachable) — the caller decides what that means. */
  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean | null> {
    if (!client.isReady) return null;
    try {
      return (await client.set(key, JSON.stringify(value), { EX: ttlSeconds, NX: true })) === "OK";
    } catch {
      return null;
    }
  },

  /** Sets many presence flags (value irrelevant) with one expiry. Best-effort like set(). */
  async markMany(keys: string[], ttlSeconds: number): Promise<void> {
    if (!keys.length || !client.isReady) return;
    try {
      await Promise.all(keys.map((k) => client.set(k, "1", { EX: ttlSeconds })));
    } catch {}
  },

  /** Presence check that tells "not there" (false) apart from "cannot tell" (null: Redis is not
   * reachable). Callers that gate access must decide what null means; get() cannot express it. */
  async exists(key: string): Promise<boolean | null> {
    if (!client.isReady) return null;
    try {
      return (await client.exists(key)) === 1;
    } catch {
      return null;
    }
  },

  /** Best-effort single-key invalidation — a miss just means the next read falls through to the
   * DB, same as any other cache miss, so a failed/unready client is safe to swallow. */
  async del(key: string): Promise<void> {
    if (!client.isReady) return;
    try {
      await client.del(key);
    } catch {}
  },
};
