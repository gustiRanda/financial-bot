const cron = require("node-cron");
const logger = require("./logger");
const { listAutoTransactions, markRun } = require("./autotx");
const { insertTransaction } = require("./sheets");
const { now } = require("./time");

function formatIDR(n) {
  return new Intl.NumberFormat("id-ID").format(Math.round(n));
}

// Checks every recurring rule and inserts the ones due today.
// Used by: the Vercel cron endpoint (api/cron/auto-tx.js), test-auto.js, and the
// local node-cron scheduler below.
//   opts.simulatedDate  dayjs object to pretend "today" is something else (testing)
//   opts.dryRun         log what would happen, write nothing, send nothing
//   opts.force          ignore the "already ran today" guard
async function runAutoTransactionCheck(bot, opts = {}) {
  const today = opts.simulatedDate || now();
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;

  logger.info(`Auto-transaction check for ${today.format("YYYY-MM-DD")} (day ${today.date()})${dryRun ? " [DRY RUN]" : ""}${force ? " [FORCE]" : ""}`);

  let items;
  try {
    items = await listAutoTransactions();
  } catch (err) {
    logger.error("Auto-transaction check: failed to list items:", err);
    return;
  }
  logger.info(`Found ${items.length} rule(s) total`);

  for (const item of items) {
    if (!item.active) {
      logger.info(`Skip "${item.description}": inactive`);
      continue;
    }
    if (item.dayOfMonth !== today.date()) {
      logger.info(`Skip "${item.description}": scheduled day ${item.dayOfMonth}, today is day ${today.date()}`);
      continue;
    }
    if (!force && item.lastRun === today.format("YYYY-MM-DD")) {
      logger.info(`Skip "${item.description}": already ran today (lastRun=${item.lastRun})`);
      continue;
    }

    logger.info(`Due: "${item.description}" — Rp ${formatIDR(item.amount)} → ${item.category} (${item.account})`);

    if (dryRun) {
      logger.info(`DRY RUN: would insert + notify chat ${item.chatId}, skipping actual write.`);
      continue;
    }

    try {
      const signed = await insertTransaction({
        description: item.description,
        category: item.category,
        amount: item.amount,
        account: item.account,
        type: item.type
      });
      await markRun(item.id, today.format("YYYY-MM-DD"));
      logger.info("Auto-transaction executed:", item);
      if (item.chatId) {
        await bot.telegram.sendMessage(
          item.chatId,
          `🔁 Auto-transaction: added ${signed}.0 to ${item.category} from ${item.account} ("${item.description}")`
        );
      }
    } catch (err) {
      logger.error(`Auto-transaction execution failed for ${item.id}:`, err);
    }
  }
}

// Only used when running as a long-lived process (phone/VPS). On Vercel nothing
// calls this — vercel.json triggers api/cron/auto-tx.js instead.
function startAutoTransactionScheduler(bot) {
  cron.schedule("0 7 * * *", () => runAutoTransactionCheck(bot), { timezone: "Asia/Jakarta" });
  logger.info("Auto-transaction scheduler started (daily 07:00 Asia/Jakarta)");
}

module.exports = { startAutoTransactionScheduler, runAutoTransactionCheck };
