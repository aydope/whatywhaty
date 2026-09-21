const fp = require("fastify-plugin");
const Redis = require("ioredis");

const REDIS_CONFIG = {
  // host: process.env.REDIS_HOST || "localhost",
  // port: +process.env.REDIS_PORT || 6379,
  // password: process.env.REDIS_PASSWORD || undefined,
  // db: +process.env.REDIS_DB || 0,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  // lazyConnect: false,
  connectTimeout: 10000,
  commandTimeout: 5000,
  keepAlive: 30000,
  // family: 4,
};

module.exports = fp(async (fastify) => {
  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { ...REDIS_CONFIG, family: 0 })
    : new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: +process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: +process.env.REDIS_DB || 0,
        family: 4,
        ...COMMON,
      });

  redis.on("connect", () => fastify.log.info("Redis connected"));
  redis.on("ready", () => fastify.log.info("Redis ready"));
  redis.on("error", (err) => fastify.log.error({ err }, "Redis error"));
  redis.on("close", () => fastify.log.warn("Redis closed"));
  redis.on("reconnecting", () => fastify.log.warn("Redis reconnecting..."));

  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async () => {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  });
});
