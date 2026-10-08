const http = require("http");
const config = require("./config");
const createBot = require("./bot");
const { startAutoTransactionScheduler } = require("./autoScheduler");


const logger = require("./logger");

process.on("unhandledRejection", (reason, promise) => {
  logger.error("UNHANDLED PROMISE REJECTION — bot is staying alive, but investigate this:");
  logger.error("Reason:", reason instanceof Error ? reason.stack || reason.message : reason);
  if (reason && reason.code) logger.error("Error code:", reason.code);
});

process.on("uncaughtException", (err, origin) => {
  logger.error("UNCAUGHT EXCEPTION — bot is staying alive, but investigate this:");
  logger.error("Origin:", origin);
  logger.error("Error:", err.stack || err.message);
  if (err.code) logger.error("Error code:", err.code);
});

process.on("exit", (code) => {
  logger.warn(`Process is actually exiting now, code: ${code}`);
});

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