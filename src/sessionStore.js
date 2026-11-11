const { Redis } = require("@upstash/redis");
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
const TTL = 60 * 60 * 24;

module.exports = {
  async get(key) { return (await redis.get(`sess:${key}`)) || undefined; },
  async set(key, value) { await redis.set(`sess:${key}`, value, { ex: TTL }); },
  async delete(key) { await redis.del(`sess:${key}`); }
};