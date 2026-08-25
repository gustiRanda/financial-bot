require("dotenv").config();
const { Telegraf } = require("telegraf");
const dayjs = require("dayjs");
const logger = require("./src/logger");
const config = require("./src/config");
const { runAutoTransactionCheck } = require("./src/autoScheduler");

// Usage:
//   node test-auto.js                        run as if today is the real date
//   node test-auto.js 2026-08-25              simulate running on a specific date
//   node test-auto.js 2026-08-25 --dry        simulate without writing to the sheet or sending Telegram messages
//   node test-auto.js 2026-08-25 --force      ignore "already ran today" so you can re-test the same date repeatedly

async function main() {
  const dateArg = process.argv[2];
  const dryRun = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const simulatedDate = dateArg && !dateArg.startsWith("--") ? dayjs(dateArg) : dayjs();

  if (!simulatedDate.isValid()) {
    console.error(`Invalid date: "${dateArg}". Use format YYYY-MM-DD.`);
    process.exit(1);
  }

  logger.info("--- Manual auto-transaction test run ---");
  const bot = new Telegraf(config.BOT_TOKEN); // not launched — only used to send test notifications

  await runAutoTransactionCheck(bot, { simulatedDate, dryRun, force });

  logger.info("--- Test run complete ---");
  process.exit(0);
}

main().catch(err => {
  logger.error("test-auto.js crashed:", err);
  process.exit(1);
});