import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const administratorOnly = (command) =>
  command
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const commandBuilders = Object.freeze({
  setup: administratorOnly(
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Create and configure the softban trap channel.'),
  ),
  logs: administratorOnly(
    new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Create or restore the private softban log channel.'),
  ),
  help: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help for the bot.')
    .setDMPermission(false),
  lsdlt: administratorOnly(
    new SlashCommandBuilder()
      .setName('lsdlt')
      .setDescription('Show the latest deleted message seen in this server.'),
  ),
});

export const commands = Object.freeze(Object.values(commandBuilders));
export const commandData = Object.freeze(commands.map((command) => command.toJSON()));

export default commandData;
