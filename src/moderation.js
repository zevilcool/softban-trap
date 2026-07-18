import { randomUUID } from "node:crypto";

import { PermissionFlagsBits } from "discord.js";

import { serializeMessage } from "./message-data.js";

const ACTION_RETRY_DELAYS_MS = [500, 1_500];
const RECOVERY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isUnknownBan(error) {
  return error?.code === 10_026 || error?.rawError?.code === 10_026;
}

function isUnknownMember(error) {
  return error?.code === 10_007 || error?.rawError?.code === 10_007;
}

function roleData(role) {
  return {
    id: role.id,
    name: role.name,
    managed: Boolean(role.managed),
    position: role.position,
  };
}

function memberRoles(member) {
  return [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .sort((left, right) => right.position - left.position)
    .map(roleData);
}

function incidentUser(snapshot) {
  return {
    id: snapshot.author?.id,
    tag: snapshot.author?.tag,
    displayName: snapshot.author?.displayName,
  };
}

async function retry(operation, delays = ACTION_RETRY_DELAYS_MS, sleep = wait) {
  let lastError;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return { value: await operation(), attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }

  throw Object.assign(lastError instanceof Error ? lastError : new Error(errorText(lastError)), {
    attempts: delays.length + 1,
  });
}

export class ModerationService {
  constructor({
    database,
    deliverPendingLogs,
    updateWarningCounter,
    logger = console,
    sleep = wait,
    now = () => Date.now(),
  }) {
    this.database = database;
    this.deliverPendingLogs = deliverPendingLogs;
    this.updateWarningCounter = updateWarningCounter;
    this.logger = logger;
    this.sleep = sleep;
    this.now = now;
    this.activeMembers = new Map();
    this.recoveryRunning = false;
  }

  async handleMessage(message) {
    if (
      !message.guild ||
      !message.author ||
      message.author.bot ||
      message.webhookId ||
      message.system
    ) {
      return { ignored: true };
    }

    const config = this.database.getGuildConfig(message.guild.id);
    if (!config?.trapChannelId || message.channelId !== config.trapChannelId) {
      return { ignored: true };
    }

    const key = `${message.guild.id}:${message.author.id}`;
    if (this.activeMembers.has(key)) {
      return this.#handleConcurrentTrigger(message);
    }

    const action = this.#processMessage(message);
    this.activeMembers.set(key, action);

    try {
      return await action;
    } finally {
      if (this.activeMembers.get(key) === action) this.activeMembers.delete(key);
    }
  }

  async #handleConcurrentTrigger(message) {
    const snapshot = this.#captureSnapshot(message);
    const id = randomUUID();
    const deleteError = await this.#deleteTrigger(message);
    const member = await this.#resolveMember(message);
    const roles = member ? memberRoles(member) : [];
    const data = {
      user: incidentUser(snapshot),
      message: snapshot,
      roles: { original: roles, removed: [], restored: [], restoreFailed: [] },
      reason: "Another trap action is already running for this member",
      error: deleteError,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };

    this.database.createIncident({
      id,
      guildId: message.guild.id,
      status: "skipped",
      data,
      pendingDelivery: true,
      createdAt: this.now(),
    });
    await this.#deliver(message.guild.id);
    return { ignored: false, status: "skipped", incidentId: id };
  }

  async #processMessage(message) {
    const snapshot = this.#captureSnapshot(message);
    const id = randomUUID();
    const createdAt = this.now();
    let member = await this.#resolveMember(message);
    const originalRoles = member ? memberRoles(member) : [];
    const baseData = {
      user: incidentUser(snapshot),
      message: snapshot,
      roles: {
        original: originalRoles,
        removed: [],
        restored: [],
        restoreFailed: [],
        managed: originalRoles.filter((role) => role.managed),
      },
      reason: "Message sent in the configured trap channel",
      error: null,
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(createdAt).toISOString(),
    };

    this.database.createIncident({
      id,
      guildId: message.guild.id,
      status: "processing",
      data: baseData,
      pendingDelivery: false,
      createdAt,
    });

    const deleteError = await this.#deleteTrigger(message);
    if (deleteError) baseData.messageDeleteError = deleteError;

    if (!member) {
      return this.#finishWithoutCounter(id, message.guild.id, "failed", {
        ...baseData,
        reason: "The member could not be resolved",
        error: "Discord did not provide a guild member for the message author.",
      });
    }

    const exemption = await this.#exemptionReason(member);
    if (exemption) {
      return this.#finishWithoutCounter(id, message.guild.id, "skipped", {
        ...baseData,
        reason: exemption,
      });
    }

    const removableRoles = [...member.roles.cache.values()]
      .filter((role) => role.id !== member.guild.id && !role.managed && role.editable)
      .sort((left, right) => right.position - left.position)
      .map(roleData);
    const auditReason = `Softban trap incident ${id}; message ${message.id}`;
    let actionData = {
      ...baseData,
      roles: {
        ...baseData.roles,
        plannedRemoval: removableRoles,
        removed: [],
      },
      stage: "role_removal_attempting",
      updatedAt: new Date(this.now()).toISOString(),
    };

    this.database.updateIncident(id, {
      status: "role_removal_attempting",
      data: actionData,
      pendingUnban: true,
      nextUnbanAttemptAt: this.now() + 60_000,
    });

    try {
      if (removableRoles.length > 0) {
        await member.roles.remove(
          removableRoles.map((role) => role.id),
          auditReason,
        );
      }
    } catch (error) {
      let refreshedMember;
      try {
        refreshedMember = await message.guild.members.fetch({ user: member.id, force: true });
      } catch (inspectionError) {
        this.database.updateIncident(id, {
          status: "role_removal_attempting",
          data: {
            ...actionData,
            reason: "Role-removal result is uncertain; recovery will reconcile the member",
            error: `Role request: ${errorText(error)}; member check: ${errorText(inspectionError)}`,
            updatedAt: new Date(this.now()).toISOString(),
          },
          pendingDelivery: true,
          pendingUnban: true,
          nextUnbanAttemptAt: this.now() + 60_000,
        });
        await this.#deliver(message.guild.id);
        return { ignored: false, status: "role_removal_attempting", incidentId: id };
      }

      const rolesActuallyRemoved = removableRoles.filter(
        (role) => !refreshedMember.roles.cache.has(role.id),
      );
      if (rolesActuallyRemoved.length !== removableRoles.length) {
        const restoration = await this.#restoreRoles(
          refreshedMember,
          rolesActuallyRemoved,
          auditReason,
        );
        return this.#finishWithoutCounter(id, message.guild.id, "failed", {
          ...actionData,
          roles: {
            ...actionData.roles,
            removed: rolesActuallyRemoved,
            restored: restoration.restored,
            restoreFailed: restoration.failed,
          },
          reason: rolesActuallyRemoved.length > 0
            ? "Role removal was incomplete; removed roles were rolled back"
            : "Role removal failed without changing the member's roles",
          error: errorText(error),
        });
      }

      actionData = {
        ...actionData,
        roleRemovalWarning: `Role-removal response was lost; server state confirmed success: ${errorText(error)}`,
      };
      member = refreshedMember;
    }

    actionData = {
      ...actionData,
      roles: { ...actionData.roles, removed: removableRoles },
      stage: "roles_removed",
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.database.updateIncident(id, {
      status: "roles_removed",
      data: actionData,
      pendingUnban: true,
      nextUnbanAttemptAt: this.now() + 60_000,
    });
    this.database.updateIncident(id, {
      status: "ban_attempting",
      data: { stage: "ban_attempting" },
    });

    let banResult;
    try {
      banResult = await retry(
        () => member.ban({ deleteMessageSeconds: 0, reason: auditReason }),
        ACTION_RETRY_DELAYS_MS,
        this.sleep,
      );
    } catch (error) {
      const banAttempts = error.attempts || ACTION_RETRY_DELAYS_MS.length + 1;
      let banConfirmed = false;

      try {
        await message.guild.bans.fetch(message.author.id);
        banConfirmed = true;
      } catch (inspectionError) {
        if (!isUnknownBan(inspectionError)) {
          this.database.updateIncident(id, {
            status: "ban_attempting",
            data: {
              ...actionData,
              reason: "Ban result is uncertain; recovery will inspect the server before acting",
              error: `Ban request: ${errorText(error)}; state check: ${errorText(inspectionError)}`,
              action: { banAttempts },
              updatedAt: new Date(this.now()).toISOString(),
            },
            pendingDelivery: true,
            pendingUnban: true,
            nextUnbanAttemptAt: this.now() + 60_000,
          });
          await this.#deliver(message.guild.id);
          return { ignored: false, status: "ban_attempting", incidentId: id };
        }
      }

      if (!banConfirmed) {
        const restoration = await this.#restoreRoles(member, removableRoles, auditReason);
        return this.#finishWithoutCounter(id, message.guild.id, "failed", {
          ...actionData,
          roles: {
            ...actionData.roles,
            restored: restoration.restored,
            restoreFailed: restoration.failed,
          },
          reason: "Ban failed after retries; removed roles were restored",
          error: errorText(error),
          action: { banAttempts },
        });
      }

      banResult = { attempts: banAttempts, confirmedAfterError: true };
    }

    this.database.scheduleUnbanRetry(id, {
      nextAttemptAt: this.now() + 60_000,
      data: {
        ...actionData,
        stage: "unban_pending",
        action: { banAttempts: banResult.attempts },
      },
    });

    try {
      const unbanResult = await retry(
        async () => {
          try {
            return await message.guild.members.unban(message.author.id, auditReason);
          } catch (error) {
            if (isUnknownBan(error)) return null;
            throw error;
          }
        },
        ACTION_RETRY_DELAYS_MS,
        this.sleep,
      );
      return this.#finishSuccess(id, message.guild.id, {
        ...actionData,
        reason: "Roles removed and member softbanned",
        action: {
          banAttempts: banResult.attempts,
          unbanAttempts: unbanResult.attempts,
        },
      });
    } catch (error) {
      this.database.scheduleUnbanRetry(id, {
        nextAttemptAt: this.now() + 60_000,
        data: {
          ...actionData,
          reason: "The ban succeeded, but automatic unban recovery is still pending",
          error: errorText(error),
          action: {
            banAttempts: banResult.attempts,
            unbanAttempts: error.attempts || ACTION_RETRY_DELAYS_MS.length + 1,
          },
          updatedAt: new Date(this.now()).toISOString(),
        },
      });
      await this.#deliver(message.guild.id);
      return { ignored: false, status: "unban_pending", incidentId: id };
    }
  }

  #captureSnapshot(message) {
    const snapshot = serializeMessage(message);
    if (snapshot.guild?.id && snapshot.messageId && snapshot.channel?.id) {
      const sentAt = Date.parse(snapshot.sentAt);
      this.database.saveMessageSnapshot({
        guildId: snapshot.guild.id,
        messageId: snapshot.messageId,
        channelId: snapshot.channel.id,
        sentAt: Number.isFinite(sentAt) ? sentAt : this.now(),
        capturedAt: this.now(),
        data: snapshot,
      });
    }
    return snapshot;
  }

  async #resolveMember(message) {
    if (message.member) return message.member;
    try {
      return await message.guild.members.fetch(message.author.id);
    } catch {
      return null;
    }
  }

  async #exemptionReason(member) {
    if (member.id === member.guild.ownerId) return "Server owner exemption";
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return "Administrator exemption";
    }

    let botMember = member.guild.members.me;
    if (!botMember) {
      try {
        botMember = await member.guild.members.fetchMe();
      } catch {
        return "The bot's guild member could not be resolved";
      }
    }

    if (member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
      return "Member's highest role is equal to or above the bot's highest role";
    }
    if (!member.manageable) return "Discord reports that the member is not manageable";
    if (!member.bannable) return "Discord reports that the member is not bannable";
    return null;
  }

  async #deleteTrigger(message) {
    try {
      await message.delete();
      return null;
    } catch (error) {
      return `Trigger message could not be deleted: ${errorText(error)}`;
    }
  }

  async #restoreRoles(member, roles, auditReason) {
    const restored = [];
    const failed = [];

    for (const role of roles) {
      const currentRole = member.guild.roles.cache.get(role.id);
      if (!currentRole || !currentRole.editable) {
        failed.push(role);
        continue;
      }

      try {
        await member.roles.add(role.id, `${auditReason}; rollback`);
        restored.push(role);
      } catch {
        failed.push(role);
      }
    }

    return { restored, failed };
  }

  async #finishWithoutCounter(id, guildId, status, data) {
    this.database.updateIncident(id, {
      status,
      data: { ...data, updatedAt: new Date(this.now()).toISOString() },
      pendingDelivery: true,
      pendingUnban: false,
      nextUnbanAttemptAt: null,
    });
    await this.#deliver(guildId);
    return { ignored: false, status, incidentId: id };
  }

  async #finishSuccess(id, guildId, data, status = "success") {
    const result = this.database.completeIncident(id, {
      status,
      data: {
        ...data,
        error: null,
        updatedAt: new Date(this.now()).toISOString(),
      },
    });

    try {
      await this.updateWarningCounter(guildId, result.softbanCount);
    } catch (error) {
      this.database.updateIncident(id, {
        data: { counterMessageError: errorText(error) },
        pendingDelivery: true,
      });
    }
    await this.#deliver(guildId);
    return { ignored: false, status, incidentId: id, count: result.softbanCount };
  }

  async #deliver(guildId) {
    try {
      await this.deliverPendingLogs(guildId);
    } catch (error) {
      this.logger.error(`Could not deliver pending incident logs for guild ${guildId}:`, error);
    }
  }

  async recoverPendingUnbans(client) {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;

    try {
      for (const incident of this.database.listPendingUnbans({ now: this.now(), limit: 100 })) {
        await this.#recoverIncident(client, incident);
      }
    } finally {
      this.recoveryRunning = false;
    }
  }

  async #recoverIncident(client, incident) {
    const data = incident.data;
    let guild = client.guilds.cache.get(incident.guildId);
    if (!guild) {
      try {
        guild = await client.guilds.fetch(incident.guildId);
      } catch (error) {
        return this.#rescheduleRecovery(incident, `Guild unavailable: ${errorText(error)}`);
      }
    }

    const userId = data.user?.id;
    const auditReason = `Softban trap incident ${incident.id}; recovery`;
    if (!userId) {
      return this.#finishWithoutCounter(incident.id, incident.guildId, "failed", {
        ...data,
        reason: "Recovery record has no user ID",
        error: "Cannot unban or restore roles without a user ID.",
      });
    }

    if (incident.status === "roles_removed") {
      return this.#restoreInterruptedRoles(guild, incident, auditReason);
    }

    if (incident.status === "role_removal_attempting") {
      return this.#reconcileInterruptedRoleRemoval(guild, incident, auditReason);
    }

    if (incident.status === "ban_attempting") {
      try {
        await guild.bans.fetch(userId);
      } catch (error) {
        if (isUnknownBan(error)) {
          return this.#restoreInterruptedRoles(guild, incident, auditReason);
        }
        return this.#rescheduleRecovery(incident, `Could not inspect ban state: ${errorText(error)}`);
      }
    }

    try {
      await guild.members.unban(userId, auditReason);
    } catch (error) {
      if (!isUnknownBan(error)) {
        return this.#rescheduleRecovery(incident, `Unban failed: ${errorText(error)}`);
      }
    }

    return this.#finishSuccess(
      incident.id,
      incident.guildId,
      {
        ...data,
        reason: "Delayed unban recovery completed",
      },
      "recovered",
    );
  }

  async #restoreInterruptedRoles(guild, incident, auditReason) {
    let member;
    try {
      member = await guild.members.fetch(incident.data.user.id);
    } catch (error) {
      if (!isUnknownMember(error)) {
        return this.#rescheduleRecovery(
          incident,
          `Could not fetch the member for role restoration: ${errorText(error)}`,
        );
      }
      return this.#finishWithoutCounter(incident.id, incident.guildId, "failed", {
        ...incident.data,
        reason: "Interrupted role removal could not be rolled back",
        error: errorText(error),
      });
    }

    const restoration = await this.#restoreRoles(
      member,
      incident.data.roles?.removed || [],
      auditReason,
    );
    return this.#finishWithoutCounter(incident.id, incident.guildId, "failed", {
      ...incident.data,
      roles: {
        ...incident.data.roles,
        restored: restoration.restored,
        restoreFailed: restoration.failed,
      },
      reason: "Interrupted ban attempt did not leave the member banned; roles were restored",
      error: restoration.failed.length > 0 ? "One or more roles could not be restored." : null,
    });
  }

  async #reconcileInterruptedRoleRemoval(guild, incident, auditReason) {
    let member;
    try {
      member = await guild.members.fetch({ user: incident.data.user.id, force: true });
    } catch (error) {
      if (!isUnknownMember(error)) {
        return this.#rescheduleRecovery(
          incident,
          `Could not inspect the member's roles: ${errorText(error)}`,
        );
      }
      return this.#finishWithoutCounter(incident.id, incident.guildId, "failed", {
        ...incident.data,
        reason: "The member left before interrupted role removal could be reconciled",
        error: errorText(error),
      });
    }

    const plannedRoles = incident.data.roles?.plannedRemoval || [];
    const rolesActuallyRemoved = plannedRoles.filter(
      (role) => !member.roles.cache.has(role.id),
    );
    const restoration = await this.#restoreRoles(member, rolesActuallyRemoved, auditReason);
    return this.#finishWithoutCounter(incident.id, incident.guildId, "failed", {
      ...incident.data,
      roles: {
        ...incident.data.roles,
        removed: rolesActuallyRemoved,
        restored: restoration.restored,
        restoreFailed: restoration.failed,
      },
      reason: rolesActuallyRemoved.length > 0
        ? "Interrupted role removal was rolled back before any ban attempt"
        : "Interrupted role removal made no detectable role changes",
      error: restoration.failed.length > 0 ? "One or more roles could not be restored." : null,
    });
  }

  async #rescheduleRecovery(incident, error) {
    const delayIndex = Math.min(incident.unbanAttempts, RECOVERY_DELAYS_MS.length - 1);
    const nextAttemptAt = this.now() + RECOVERY_DELAYS_MS[delayIndex];
    const data = {
      ...incident.data,
      reason: "Automatic recovery is still pending",
      error,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const status = incident.status === "unban_pending" ? "unban_pending" : incident.status;

    if (status === "unban_pending") {
      this.database.scheduleUnbanRetry(incident.id, { nextAttemptAt, data });
    } else {
      this.database.updateIncident(incident.id, {
        status,
        data,
        pendingDelivery: true,
        pendingUnban: true,
        unbanAttempts: incident.unbanAttempts + 1,
        nextUnbanAttemptAt: nextAttemptAt,
      });
    }
    await this.#deliver(incident.guildId);
    return { ignored: false, status, incidentId: incident.id };
  }
}

export {
  ACTION_RETRY_DELAYS_MS,
  RECOVERY_DELAYS_MS,
  errorText,
  isUnknownBan,
  isUnknownMember,
  retry,
};
