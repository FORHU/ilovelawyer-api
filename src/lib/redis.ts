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
