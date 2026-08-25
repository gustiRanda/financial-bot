const config = require("./config");
const createBot = require("./bot");
const { startAutoTransactionScheduler } = require("./autoScheduler");

const bot = createBot(config.BOT_TOKEN);
startAutoTransactionScheduler(bot);
bot.launch();

console.log("Finance bot running");