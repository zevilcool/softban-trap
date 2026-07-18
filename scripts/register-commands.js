import 'dotenv/config';

import { REST, Routes } from 'discord.js';

import { commandData } from '../src/commands.js';

function requireEnvironmentVariable(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function registerCommands() {
  const token = requireEnvironmentVariable('DISCORD_TOKEN');
  const clientId = requireEnvironmentVariable('CLIENT_ID');
  const guildId = process.env.GUILD_ID?.trim();
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commandData });

  const scope = guildId ? `guild ${guildId}` : 'globally';
  console.log(`Registered ${commandData.length} slash commands ${scope}.`);
}

registerCommands().catch((error) => {
  console.error('Failed to register slash commands:', error.message);
  process.exitCode = 1;
});
