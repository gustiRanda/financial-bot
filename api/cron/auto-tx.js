const { Telegraf } = require("telegraf");
const { runAutoTransactionCheck } = require("../../src/autoScheduler");

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("unauthorized");
  }
  await runAutoTransactionCheck(new Telegraf(process.env.BOT_TOKEN));
  res.status(200).send("done");
};