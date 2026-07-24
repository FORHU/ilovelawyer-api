import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { redis } from "../lib/redis";

export default class HealthCtrl {
  static async check(_req: Request, res: Response) {
    const [databaseUp, redisUp] = await Promise.all([
      prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      redis.ping(),
    ]);

    const healthy = databaseUp && redisUp;

    return res.status(healthy ? 200 : 503).json({
      message: "Welcome to my API",
      status: healthy ? "ok" : "degraded",
      database: databaseUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
    });
  }
}
