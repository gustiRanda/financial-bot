const createBot = require("../src/bot");
const logger = require("../src/logger");

const bot = createBot(process.env.BOT_TOKEN);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Finance bot webhook is up.");
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }
  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    logger.error("handleUpdate failed:", err);
  }
  res.status(200).send("ok"); // always 200 so Telegram doesn't retry-storm
};