const createBot = require("../src/bot");
const logger = require("../src/logger");
const { Redis } = require("@upstash/redis");
const { waitUntil } = require("@vercel/functions");

const bot = createBot(process.env.BOT_TOKEN);
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// Same hook the official @vercel/functions package reads. If Vercel provides it, work can
// continue after we've answered Telegram. If not, waitUntil() would silently do nothing and the
// work could be frozen mid-way — so we check first instead of trusting it blindly.
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
function canRunInBackground() {
  return typeof globalThis[REQUEST_CONTEXT]?.get?.()?.waitUntil === "function";
}

// Never throws: failures are logged (and the user is told by bot.catch in bot.js).
async function processUpdate(update) {
  const updateId = update?.update_id;
  const started = Date.now();
  try {
    await bot.handleUpdate(update);
  } catch (err) {
    logger.error(`handleUpdate failed for update ${updateId} after ${Date.now() - started}ms:`, err);
  }
  logger.info(`Update ${updateId} handled in ${Date.now() - started}ms`);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Finance bot webhook is up.");
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  // Safety net: if Telegram ever re-sends an update, never process it (or write to the sheet) twice.
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

  const work = processUpdate(req.body);

  if (canRunInBackground()) {
    // Answer Telegram right away so it never re-sends, then keep working (up to maxDuration).
    waitUntil(work);
    return res.status(200).send("ok");
  }

  logger.warn("waitUntil is NOT available here — answering Telegram only after the work is done. Long AI waits may cause Telegram re-sends (they are skipped by the duplicate check).");
  await work;
  return res.status(200).send("ok");
};
