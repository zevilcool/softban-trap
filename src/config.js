import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function requireValue(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const configuredPath = env.DATABASE_PATH?.trim() || "./data/bot.sqlite";

  return {
    token: requireValue(env, "DISCORD_TOKEN"),
    clientId: requireValue(env, "CLIENT_ID"),
    guildId: env.GUILD_ID?.trim() || null,
    databasePath: path.resolve(configuredPath),
    snapshotTtlMs: SEVEN_DAYS_MS,
  };
}

export { SEVEN_DAYS_MS };
