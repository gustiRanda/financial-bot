const http = require("http");
const config = require("./config");
const createBot = require("./bot");
const { startAutoTransactionScheduler } = require("./autoScheduler");

const bot = createBot(config.BOT_TOKEN);
startAutoTransactionScheduler(bot);
bot.launch();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => {
  console.log(`Ping server listening on port ${PORT}`);
});

console.log("Finance bot running");