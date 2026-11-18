const createBot = require("../src/bot");
const logger = require("../src/logger");
const { Redis } = require("@upstash/redis");

const bot = createBot(process.env.BOT_TOKEN);
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Finance bot webhook is up.");
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  // Telegram re-sends an update if we're slow to answer. Remember update_ids for 10 minutes
  // so a re-sent photo/message is never processed (and written to the sheet) twice.
  const updateId = req.body?.update_id;
  if (updateId !== undefined) {
    try {
      const firstTime = await redis.set(`upd:${updateId}`, 1, { nx: true, ex: 600 });
      if (!firstTime) {
        logger.warn(`Duplicate Telegram update ${updateId} (a re-send) — skipping`);
        return res.status(200).send("duplicate");
      }
    } catch (err) {
      logger.error("Duplicate check failed (processing the update anyway):", err.message);
    }
  }

  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    logger.error("handleUpdate failed:", err);
  }
  res.status(200).send("ok"); // always 200 so Telegram doesn't retry-storm
};
