import { randomBytes } from "node:crypto";

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
} from "discord.js";

import { KeyedDrainCoordinator, KeyedTaskQueue, TaskTracker } from "./async-control.js";
import { Database } from "./database.js";
import {
  buildHelpPayload,
  buildIncidentLogPayload,
  buildLastDeletedPayload,
  buildWarningPayload,
} from "./discord-payloads.js";
import {
  chooseLatestBulkSnapshot,
  mergeDeletedMessage,
  serializeMessage,
} from "./message-data.js";
import { ModerationService } from "./moderation.js";

const BOT_PERMISSIONS = Object.freeze({
  ManageChannels: PermissionFlagsBits.ManageChannels,
  ManageRoles: PermissionFlagsBits.ManageRoles,
  ManageMessages: PermissionFlagsBits.ManageMessages,
  BanMembers: PermissionFlagsBits.BanMembers,
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  AttachFiles: PermissionFlagsBits.AttachFiles,
});

const LOG_PERMISSIONS = Object.freeze({
  ManageChannels: PermissionFlagsBits.ManageChannels,
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  EmbedLinks: PermissionFlagsBits.EmbedLinks,
  AttachFiles: PermissionFlagsBits.AttachFiles,
});

const LOG_DELIVERY_BATCH_SIZE = 100;
const MAINTENANCE_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

function commandErrorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isGuildTextChannel(channel) {
  return channel?.type === ChannelType.GuildText;
}

export function createBot(config, { logger = console } = {}) {
  const database = new Database(config.databasePath);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.User],
  });
  const taskTracker = new TaskTracker();
  const warningUpdates = new KeyedTaskQueue();
  const timers = new Set();
  let stopped = false;
  let stopPromise = null;

  async function getBotMember(guild) {
    return guild.members.me || guild.members.fetchMe();
  }

  async function requireBotPermissions(guild, required = BOT_PERMISSIONS) {
    const botMember = await getBotMember(guild);
    const missing = Object.entries(required)
      .filter(([, permission]) => !botMember.permissions.has(permission))
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(`The bot is missing required permissions: ${missing.join(", ")}`);
    }
    return botMember;
  }

  async function fetchTextChannel(guild, channelId) {
    if (!channelId) return null;
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
      try {
        channel = await guild.channels.fetch(channelId);
      } catch {
        return null;
      }
    }
    return isGuildTextChannel(channel) ? channel : null;
  }

  function trapPermissionOverwrites(guild, botMember) {
    return [
      {
        id: guild.roles.everyone.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
        deny: [
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];
  }

  function logPermissionOverwrites(guild, botMember) {
    return [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];
  }

  function randomChannelName(guild) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = randomBytes(6).toString("hex");
      if (![...guild.channels.cache.values()].some((channel) => channel.name === candidate)) {
        return candidate;
      }
    }
    throw new Error("Could not generate an unused random channel name");
  }

  async function ensureWarningMessageUnlocked(guild, channel) {
    const guildConfig = database.ensureGuild(guild.id);
    let warningMessage = null;

    if (guildConfig.warningMessageId) {
      try {
        warningMessage = await channel.messages.fetch(guildConfig.warningMessageId);
      } catch {
        warningMessage = null;
      }
    }

    const latestConfig = database.getGuildConfig(guild.id);
    if (!warningMessage || warningMessage.author.id !== client.user.id) {
      warningMessage = await channel.send(buildWarningPayload(latestConfig.softbanCount));
      database.setWarningMessage(guild.id, warningMessage.id);
      return warningMessage;
    }

    await warningMessage.edit(buildWarningPayload(latestConfig.softbanCount));
    return warningMessage;
  }

  async function updateWarningCounter(guildId, _softbanCount) {
    if (stopped) return null;
    const update = warningUpdates.run(guildId, async () => {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw new Error("The server is no longer available to the bot");
      const guildConfig = database.getGuildConfig(guildId);
      const channel = await fetchTextChannel(guild, guildConfig?.trapChannelId);
      if (!channel) throw new Error("The configured trap channel no longer exists.");
      return ensureWarningMessageUnlocked(guild, channel);
    });
    return taskTracker.track(update);
  }

  async function drainPendingLogs(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return { processed: 0, retryLater: false };
    const guildConfig = database.getGuildConfig(guildId);
    const channel = await fetchTextChannel(guild, guildConfig?.logChannelId);
    if (!channel) return { processed: 0, retryLater: false };

    let delivered = 0;
    while (true) {
      const incidents = database.listPendingIncidentLogs({
        guildId,
        limit: LOG_DELIVERY_BATCH_SIZE,
      });
      if (incidents.length === 0) break;

      for (const incident of incidents) {
        try {
          await channel.send(
            buildIncidentLogPayload({
              id: incident.id,
              status: incident.status,
              ...incident.data,
              createdAt: incident.data.createdAt || new Date(incident.createdAt).toISOString(),
              updatedAt: incident.data.updatedAt || new Date(incident.updatedAt).toISOString(),
            }),
          );
          database.markIncidentLogDelivered(incident.id);
          delivered += 1;
        } catch (error) {
          logger.error(`Could not deliver incident ${incident.id}:`, error);
          return { processed: delivered, retryLater: true };
        }
      }
    }
    return { processed: delivered, retryLater: false };
  }

  const logDeliveries = new KeyedDrainCoordinator(drainPendingLogs);

  async function deliverPendingLogs(guildId) {
    if (stopped) return 0;
    return taskTracker.track(logDeliveries.request(guildId));
  }

  const moderation = new ModerationService({
    database,
    deliverPendingLogs,
    updateWarningCounter,
    logger,
  });

  async function setupTrap(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const botMember = await requireBotPermissions(guild);
    const guildConfig = database.ensureGuild(guild.id);
    let channel = await fetchTextChannel(guild, guildConfig.trapChannelId);

    if (!channel) {
      database.setTrapChannel(guild.id, null, null);
      await guild.channels.fetch();
      channel = await guild.channels.create({
        name: randomChannelName(guild),
        type: ChannelType.GuildText,
        reason: `Softban trap setup requested by ${interaction.user.id}`,
        permissionOverwrites: trapPermissionOverwrites(guild, botMember),
      });
      database.setTrapChannel(guild.id, channel.id, null);
    } else {
      await channel.permissionOverwrites.set(
        trapPermissionOverwrites(guild, botMember),
        `Softban trap permissions refreshed by ${interaction.user.id}`,
      );
    }

    await updateWarningCounter(guild.id);
    await interaction.editReply(`Trap channel ready: <#${channel.id}>`);
  }

  async function setupLogs(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const botMember = await requireBotPermissions(guild, LOG_PERMISSIONS);
    const guildConfig = database.ensureGuild(guild.id);
    let channel = await fetchTextChannel(guild, guildConfig.logChannelId);

    if (!channel) {
      database.setLogChannel(guild.id, null);
      channel = await guild.channels.create({
        name: "softbanned-logs",
        type: ChannelType.GuildText,
        reason: `Softban log setup requested by ${interaction.user.id}`,
        permissionOverwrites: logPermissionOverwrites(guild, botMember),
      });
      database.setLogChannel(guild.id, channel.id);
    } else {
      if (channel.name !== "softbanned-logs") {
        await channel.setName("softbanned-logs", "Restoring the configured softban log name");
      }
      await channel.permissionOverwrites.set(
        logPermissionOverwrites(guild, botMember),
        `Softban log permissions refreshed by ${interaction.user.id}`,
      );
    }

    const delivered = await deliverPendingLogs(guild.id);
    await interaction.editReply(
      `Log channel ready: <#${channel.id}>. Delivered ${delivered} pending log${delivered === 1 ? "" : "s"}`,
    );
  }

  async function showLastDeleted(interaction) {
    const stored = database.getLastDeletedMessage(interaction.guild.id);
    if (!stored) {
      await interaction.reply({
        content: "No deleted message has been seen in this server",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply(
      buildLastDeletedPayload({
        ...stored.data,
        deletedAt: new Date(stored.deletedAt).toISOString(),
      }),
    );
  }

  function isAdministrator(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
  }

  async function runCommand(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "This command can only be used in a server",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (["setup", "logs", "lsdlt"].includes(interaction.commandName) && !isAdministrator(interaction)) {
      await interaction.reply({
        content: "You need the Administrator permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (interaction.commandName === "setup") await setupTrap(interaction);
      else if (interaction.commandName === "logs") await setupLogs(interaction);
      else if (interaction.commandName === "lsdlt") await showLastDeleted(interaction);
      else if (interaction.commandName === "help") await interaction.reply(buildHelpPayload());
    } catch (error) {
      logger.error(`Command /${interaction.commandName} failed:`, error);
      const response = { content: `Command failed: ${commandErrorText(error)}`, allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
    }
  }

  function saveSnapshot(snapshot, capturedAt = Date.now()) {
    if (!snapshot.guild?.id || !snapshot.channel?.id || !snapshot.messageId) return;
    const sentAt = Date.parse(snapshot.sentAt);
    database.saveMessageSnapshot({
      guildId: snapshot.guild.id,
      messageId: snapshot.messageId,
      channelId: snapshot.channel.id,
      sentAt: Number.isFinite(sentAt) ? sentAt : capturedAt,
      capturedAt,
      data: snapshot,
    });
  }

  async function recordSingleDeletion(message) {
    const guildId = message.guildId || message.guild?.id;
    if (!guildId || !message.id) return;
    const stored = database.getMessageSnapshot(guildId, message.id)?.data;
    const snapshot = mergeDeletedMessage(message, stored);
    const deletedAt = Date.now();
    database.setLastDeletedMessage(
      guildId,
      { snapshot, bulkDeleteCount: 1 },
      deletedAt,
    );
    database.deleteMessageSnapshot(guildId, message.id);

    const guildConfig = database.getGuildConfig(guildId);
    if (guildConfig?.warningMessageId === message.id) {
      database.setWarningMessage(guildId, null);
      await updateWarningCounter(guildId);
    }
  }

  async function recordBulkDeletion(messages, channel) {
    const guildId = channel.guildId || channel.guild?.id;
    if (!guildId) return;
    const latest = chooseLatestBulkSnapshot(
      messages,
      (messageId) => database.getMessageSnapshot(guildId, messageId)?.data,
    );
    if (!latest) return;

    const { bulkCount, ...snapshot } = latest;
    const deletedAt = Date.now();
    database.setLastDeletedMessage(
      guildId,
      { snapshot, bulkDeleteCount: bulkCount },
      deletedAt,
    );
    for (const message of messages.values()) {
      database.deleteMessageSnapshot(guildId, message.id);
    }

    const guildConfig = database.getGuildConfig(guildId);
    if (guildConfig?.warningMessageId && messages.has(guildConfig.warningMessageId)) {
      database.setWarningMessage(guildId, null);
      await updateWarningCounter(guildId);
    }
  }

  async function reconcileGuild(guild) {
    const guildConfig = database.ensureGuild(guild.id);
    if (guildConfig.trapChannelId) {
      const channel = await fetchTextChannel(guild, guildConfig.trapChannelId);
      if (!channel) database.setTrapChannel(guild.id, null, null);
      else {
        try {
          await updateWarningCounter(guild.id);
        } catch (error) {
          logger.error(`Could not reconcile warning message in guild ${guild.id}:`, error);
        }
      }
    }
    if (guildConfig.logChannelId && !(await fetchTextChannel(guild, guildConfig.logChannelId))) {
      database.setLogChannel(guild.id, null);
    }
    await deliverPendingLogs(guild.id);
  }

  function startTrackedTask(label, task) {
    const promise = taskTracker.start(task);
    if (promise) promise.catch((error) => logger.error(`${label}:`, error));
    return promise;
  }

  function scheduleInterval(label, task, intervalMs) {
    if (stopped) return;
    const timer = setInterval(() => {
      startTrackedTask(label, task);
    }, intervalMs);
    timers.add(timer);
  }

  client.on(Events.InteractionCreate, (interaction) => {
    startTrackedTask("interactionCreate handling failed", () => runCommand(interaction));
  });
  client.on(Events.MessageCreate, (message) => {
    startTrackedTask("messageCreate handling failed", async () => {
      saveSnapshot(serializeMessage(message));
      await moderation.handleMessage(message);
    });
  });
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    startTrackedTask("messageUpdate snapshot failed", () => {
      const guildId = newMessage.guildId || oldMessage.guildId;
      const stored = guildId && newMessage.id
        ? database.getMessageSnapshot(guildId, newMessage.id)?.data
        : null;
      saveSnapshot(mergeDeletedMessage(newMessage, stored));
    });
  });
  client.on(Events.MessageDelete, (message) => {
    startTrackedTask("messageDelete handling failed", () => recordSingleDeletion(message));
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    startTrackedTask(
      "messageDeleteBulk handling failed",
      () => recordBulkDeletion(messages, channel),
    );
  });
  client.on(Events.ChannelDelete, (channel) => {
    startTrackedTask("channelDelete handling failed", () => {
      if (!channel.guildId) return;
      const guildConfig = database.getGuildConfig(channel.guildId);
      if (guildConfig?.trapChannelId === channel.id) {
        database.setTrapChannel(channel.guildId, null, null);
      }
      if (guildConfig?.logChannelId === channel.id) {
        database.setLogChannel(channel.guildId, null);
      }
    });
  });
  client.on(Events.GuildCreate, (guild) => {
    startTrackedTask(`Guild setup failed for ${guild.id}`, () => reconcileGuild(guild));
  });
  client.on(Events.Error, (error) => logger.error("Discord client error:", error));
  client.on(Events.Warn, (warning) => logger.warn("Discord client warning:", warning));
  async function initializeReadyClient(readyClient) {
    logger.log(`Logged in as ${readyClient.user.tag}.`);
    database.pruneExpiredSnapshots();
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        await reconcileGuild(guild);
      } catch (error) {
        logger.error(`Startup reconciliation failed for guild ${guild.id}:`, error);
      }
    }
    await moderation.recoverPendingUnbans(readyClient);

    scheduleInterval(
      "Pending unban recovery failed",
      () => moderation.recoverPendingUnbans(readyClient),
      MAINTENANCE_INTERVAL_MS,
    );
    scheduleInterval(
      "Pending incident log delivery failed",
      () => Promise.all(
        [...readyClient.guilds.cache.values()].map((guild) => deliverPendingLogs(guild.id)),
      ),
      MAINTENANCE_INTERVAL_MS,
    );
    scheduleInterval(
      "Message snapshot pruning failed",
      () => database.pruneExpiredSnapshots(),
      60 * 60_000,
    );
  }

  client.once(Events.ClientReady, (readyClient) => {
    startTrackedTask(
      "Bot ready initialization failed",
      () => initializeReadyClient(readyClient),
    );
  });

  return {
    client,
    database,
    moderation,
    deliverPendingLogs,
    updateWarningCounter,
    async start() {
      return client.login(config.token);
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      taskTracker.stopAccepting();
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      stopPromise = (async () => {
        const drained = await taskTracker.waitForIdle(SHUTDOWN_TIMEOUT_MS);
        if (!drained) {
          logger.warn(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing...`);
        }
        try {
          await client.destroy();
        } finally {
          database.close();
        }
      })();
      return stopPromise;
    },
  };
}

export { BOT_PERMISSIONS, LOG_PERMISSIONS };
