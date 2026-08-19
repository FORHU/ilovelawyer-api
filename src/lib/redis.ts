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

/** Blocking commands (BRPOP) need their own connection — they would otherwise stall cache reads. */
export function createRedisWorkerClient() {
  return client.duplicate();
}

export type RedisWorkerClient = ReturnType<typeof createRedisWorkerClient>;

export function isRedisReady(): boolean {
  return client.isReady;
}

export { client as redisClient };

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
};
