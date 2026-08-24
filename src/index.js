const config =
require("./config");

const createBot =
require("./bot");

const bot =
createBot(
  config.BOT_TOKEN
);

bot.launch();

console.log(
  "Finance bot running"
);