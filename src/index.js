import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";

let application;

try {
  const config = loadConfig();
  application = createBot(config);
  await application.start();
} catch (error) {
  console.error("Bot startup failed:", error);
  process.exitCode = 1;
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);
  try {
    await application?.stop();
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
o

