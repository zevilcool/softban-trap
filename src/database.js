import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

const SCHEMA_VERSION = 1;
export const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function assertId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertTimestamp(value, name, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError('limit must be an integer between 1 and 1000');
  }
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function assertJsonObject(value, name = 'data') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
}

function serialize(value) {
  return JSON.stringify(value);
}

function deserialize(value) {
  return JSON.parse(value);
}

function toConfig(row) {
  if (!row) {
    return null;
  }

  return {
    guildId: row.guild_id,
    trapChannelId: row.trap_channel_id,
    warningMessageId: row.warning_message_id,
    logChannelId: row.log_channel_id,
    softbanCount: row.softban_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIncident(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    guildId: row.guild_id,
    status: row.status,
    data: deserialize(row.data_json),
    pendingDelivery: Boolean(row.pending_delivery),
    pendingUnban: Boolean(row.pending_unban),
    counterIncremented: Boolean(row.counter_incremented),
    unbanAttempts: row.unban_attempts,
    nextUnbanAttemptAt: row.next_unban_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSnapshot(row) {
  if (!row) {
    return null;
  }

  return {
    guildId: row.guild_id,
    messageId: row.message_id,
    channelId: row.channel_id,
    sentAt: row.sent_at,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    data: deserialize(row.data_json),
  };
}

function toLastDeleted(row) {
  if (!row) {
    return null;
  }

  return {
    guildId: row.guild_id,
    deletedAt: row.deleted_at,
    data: deserialize(row.data_json),
  };
}

export class Database {
  constructor(filename) {
    assertId(filename, 'filename');

    if (filename !== ':memory:') {
      mkdirSync(dirname(resolve(filename)), { recursive: true });
    }

    this.connection = new BetterSqlite3(filename);
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('foreign_keys = ON');
    this.connection.pragma('busy_timeout = 5000');

    this.#migrate();
    this.#prepareStatements();
    this.#prepareTransactions();
  }

  #migrate() {
    const version = this.connection.pragma('user_version', { simple: true });

    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }

    if (version === SCHEMA_VERSION) {
      return;
    }

    this.connection.transaction(() => {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS guild_configs (
          guild_id TEXT PRIMARY KEY,
          trap_channel_id TEXT,
          warning_message_id TEXT,
          log_channel_id TEXT,
          softban_count INTEGER NOT NULL DEFAULT 0 CHECK (softban_count >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          status TEXT NOT NULL,
          data_json TEXT NOT NULL,
          pending_delivery INTEGER NOT NULL DEFAULT 1 CHECK (pending_delivery IN (0, 1)),
          pending_unban INTEGER NOT NULL DEFAULT 0 CHECK (pending_unban IN (0, 1)),
          counter_incremented INTEGER NOT NULL DEFAULT 0 CHECK (counter_incremented IN (0, 1)),
          unban_attempts INTEGER NOT NULL DEFAULT 0 CHECK (unban_attempts >= 0),
          next_unban_attempt_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS incidents_pending_delivery_idx
          ON incidents (pending_delivery, created_at);
        CREATE INDEX IF NOT EXISTS incidents_pending_unban_idx
          ON incidents (pending_unban, next_unban_attempt_at, created_at);

        CREATE TABLE IF NOT EXISTS message_snapshots (
          guild_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          sent_at INTEGER NOT NULL,
          captured_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY (guild_id, message_id),
          FOREIGN KEY (guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS message_snapshots_expiry_idx
          ON message_snapshots (expires_at);

        CREATE TABLE IF NOT EXISTS last_deleted_messages (
          guild_id TEXT PRIMARY KEY,
          deleted_at INTEGER NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY (guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE
        );
      `);

      this.connection.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  #prepareStatements() {
    this.statements = {
      ensureGuild: this.connection.prepare(`
        INSERT INTO guild_configs (guild_id, created_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (guild_id) DO NOTHING
      `),
      getGuild: this.connection.prepare('SELECT * FROM guild_configs WHERE guild_id = ?'),
      setTrap: this.connection.prepare(`
        UPDATE guild_configs
        SET trap_channel_id = ?, warning_message_id = ?, updated_at = ?
        WHERE guild_id = ?
      `),
      setWarning: this.connection.prepare(`
        UPDATE guild_configs SET warning_message_id = ?, updated_at = ? WHERE guild_id = ?
      `),
      setLog: this.connection.prepare(`
        UPDATE guild_configs SET log_channel_id = ?, updated_at = ? WHERE guild_id = ?
      `),
      insertIncident: this.connection.prepare(`
        INSERT INTO incidents (
          id, guild_id, status, data_json, pending_delivery, pending_unban,
          counter_incremented, unban_attempts, next_unban_attempt_at, created_at, updated_at
        ) VALUES (
          @id, @guildId, @status, @dataJson, @pendingDelivery, @pendingUnban,
          0, 0, @nextUnbanAttemptAt, @createdAt, @createdAt
        )
        ON CONFLICT (id) DO NOTHING
      `),
      getIncident: this.connection.prepare('SELECT * FROM incidents WHERE id = ?'),
      updateIncident: this.connection.prepare(`
        UPDATE incidents
        SET status = @status,
            data_json = @dataJson,
            pending_delivery = @pendingDelivery,
            pending_unban = @pendingUnban,
            unban_attempts = @unbanAttempts,
            next_unban_attempt_at = @nextUnbanAttemptAt,
            updated_at = @updatedAt
        WHERE id = @id
      `),
      completeIncident: this.connection.prepare(`
        UPDATE incidents
        SET status = @status,
            data_json = @dataJson,
            pending_delivery = 1,
            pending_unban = 0,
            counter_incremented = 1,
            next_unban_attempt_at = NULL,
            updated_at = @updatedAt
        WHERE id = @id
      `),
      incrementCounter: this.connection.prepare(`
        UPDATE guild_configs
        SET softban_count = softban_count + 1, updated_at = ?
        WHERE guild_id = ?
      `),
      markDelivered: this.connection.prepare(`
        UPDATE incidents SET pending_delivery = 0, updated_at = ? WHERE id = ?
      `),
      listPendingLogs: this.connection.prepare(`
        SELECT * FROM incidents
        WHERE pending_delivery = 1
        ORDER BY created_at ASC
        LIMIT ?
      `),
      listPendingLogsForGuild: this.connection.prepare(`
        SELECT * FROM incidents
        WHERE pending_delivery = 1 AND guild_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `),
      listPendingUnbans: this.connection.prepare(`
        SELECT * FROM incidents
        WHERE pending_unban = 1
          AND (next_unban_attempt_at IS NULL OR next_unban_attempt_at <= ?)
        ORDER BY COALESCE(next_unban_attempt_at, created_at) ASC
        LIMIT ?
      `),
      upsertSnapshot: this.connection.prepare(`
        INSERT INTO message_snapshots (
          guild_id, message_id, channel_id, sent_at, captured_at, expires_at, data_json
        ) VALUES (
          @guildId, @messageId, @channelId, @sentAt, @capturedAt, @expiresAt, @dataJson
        )
        ON CONFLICT (guild_id, message_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          sent_at = excluded.sent_at,
          captured_at = excluded.captured_at,
          expires_at = excluded.expires_at,
          data_json = excluded.data_json
      `),
      getSnapshot: this.connection.prepare(`
        SELECT * FROM message_snapshots
        WHERE guild_id = ? AND message_id = ? AND expires_at > ?
      `),
      deleteSnapshot: this.connection.prepare(`
        DELETE FROM message_snapshots WHERE guild_id = ? AND message_id = ?
      `),
      upsertLastDeleted: this.connection.prepare(`
        INSERT INTO last_deleted_messages (guild_id, deleted_at, data_json)
        VALUES (?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET
          deleted_at = excluded.deleted_at,
          data_json = excluded.data_json
        WHERE excluded.deleted_at >= last_deleted_messages.deleted_at
      `),
      getLastDeleted: this.connection.prepare(`
        SELECT * FROM last_deleted_messages WHERE guild_id = ?
      `),
      pruneSnapshots: this.connection.prepare(`
        DELETE FROM message_snapshots WHERE expires_at <= ?
      `),
    };
  }

  #prepareTransactions() {
    this.transactions = {
      createIncident: this.connection.transaction((incident) => {
        this.#ensureGuildRow(incident.guildId, incident.createdAt);
        const result = this.statements.insertIncident.run(incident);
        return {
          created: result.changes === 1,
          incident: toIncident(this.statements.getIncident.get(incident.id)),
        };
      }),
      updateIncident: this.connection.transaction((incidentId, patch) => {
        const current = toIncident(this.statements.getIncident.get(incidentId));
        if (!current) {
          throw new Error(`Incident ${incidentId} does not exist`);
        }

        const updatedAt = Date.now();
        const data = patch.data === undefined
          ? current.data
          : { ...current.data, ...patch.data };

        this.statements.updateIncident.run({
          id: incidentId,
          status: patch.status ?? current.status,
          dataJson: serialize(data),
          pendingDelivery: patch.pendingDelivery === undefined
            ? Number(current.pendingDelivery)
            : Number(patch.pendingDelivery),
          pendingUnban: patch.pendingUnban === undefined
            ? Number(current.pendingUnban)
            : Number(patch.pendingUnban),
          unbanAttempts: patch.unbanAttempts ?? current.unbanAttempts,
          nextUnbanAttemptAt: patch.nextUnbanAttemptAt === undefined
            ? current.nextUnbanAttemptAt
            : patch.nextUnbanAttemptAt,
          updatedAt,
        });

        return toIncident(this.statements.getIncident.get(incidentId));
      }),
      completeIncident: this.connection.transaction((incidentId, status, data) => {
        const current = toIncident(this.statements.getIncident.get(incidentId));
        if (!current) {
          throw new Error(`Incident ${incidentId} does not exist`);
        }

        if (current.counterIncremented) {
          return {
            counterIncremented: false,
            softbanCount: this.statements.getGuild.get(current.guildId).softban_count,
            incident: current,
          };
        }

        const updatedAt = Date.now();
        this.statements.incrementCounter.run(updatedAt, current.guildId);

        this.statements.completeIncident.run({
          id: incidentId,
          status,
          dataJson: serialize({ ...current.data, ...data }),
          updatedAt,
        });

        return {
          counterIncremented: true,
          softbanCount: this.statements.getGuild.get(current.guildId).softban_count,
          incident: toIncident(this.statements.getIncident.get(incidentId)),
        };
      }),
      recordDeleted: this.connection.transaction((guildId, messageId, deletedAt, data) => {
        this.#ensureGuildRow(guildId, deletedAt);
        const snapshot = toSnapshot(
          this.statements.getSnapshot.get(guildId, messageId, deletedAt),
        );
        const deletedData = {
          ...(snapshot?.data ?? {}),
          ...data,
          guildId,
          messageId,
          channelId: data.channelId ?? snapshot?.channelId ?? null,
          sentAt: data.sentAt ?? snapshot?.sentAt ?? null,
        };

        this.statements.upsertLastDeleted.run(guildId, deletedAt, serialize(deletedData));
        this.statements.deleteSnapshot.run(guildId, messageId);
        return toLastDeleted(this.statements.getLastDeleted.get(guildId));
      }),
    };
  }

  #ensureGuildRow(guildId, now = Date.now()) {
    assertId(guildId, 'guildId');
    assertTimestamp(now, 'now');
    this.statements.ensureGuild.run(guildId, now, now);
  }

  ensureGuild(guildId) {
    this.#ensureGuildRow(guildId);
    return this.getGuildConfig(guildId);
  }

  getGuildConfig(guildId) {
    assertId(guildId, 'guildId');
    return toConfig(this.statements.getGuild.get(guildId));
  }

  setTrapChannel(guildId, trapChannelId, warningMessageId = null) {
    assertId(guildId, 'guildId');
    if (trapChannelId !== null) {
      assertId(trapChannelId, 'trapChannelId');
    }
    if (warningMessageId !== null) {
      assertId(warningMessageId, 'warningMessageId');
    }

    this.#ensureGuildRow(guildId);
    this.statements.setTrap.run(trapChannelId, warningMessageId, Date.now(), guildId);
    return this.getGuildConfig(guildId);
  }

  setWarningMessage(guildId, warningMessageId) {
    assertId(guildId, 'guildId');
    if (warningMessageId !== null) {
      assertId(warningMessageId, 'warningMessageId');
    }

    this.#ensureGuildRow(guildId);
    this.statements.setWarning.run(warningMessageId, Date.now(), guildId);
    return this.getGuildConfig(guildId);
  }

  setLogChannel(guildId, logChannelId) {
    assertId(guildId, 'guildId');
    if (logChannelId !== null) {
      assertId(logChannelId, 'logChannelId');
    }

    this.#ensureGuildRow(guildId);
    this.statements.setLog.run(logChannelId, Date.now(), guildId);
    return this.getGuildConfig(guildId);
  }

  createIncident({
    id,
    guildId,
    status = 'received',
    data = {},
    pendingDelivery = true,
    pendingUnban = false,
    nextUnbanAttemptAt = null,
    createdAt = Date.now(),
  }) {
    assertId(id, 'id');
    assertId(guildId, 'guildId');
    assertId(status, 'status');
    assertJsonObject(data);
    assertBoolean(pendingDelivery, 'pendingDelivery');
    assertBoolean(pendingUnban, 'pendingUnban');
    assertTimestamp(createdAt, 'createdAt');
    assertTimestamp(nextUnbanAttemptAt, 'nextUnbanAttemptAt', { nullable: true });

    return this.transactions.createIncident({
      id,
      guildId,
      status,
      dataJson: serialize(data),
      pendingDelivery: Number(Boolean(pendingDelivery)),
      pendingUnban: Number(Boolean(pendingUnban)),
      nextUnbanAttemptAt,
      createdAt,
    });
  }

  getIncident(incidentId) {
    assertId(incidentId, 'incidentId');
    return toIncident(this.statements.getIncident.get(incidentId));
  }

  updateIncident(incidentId, patch = {}) {
    assertId(incidentId, 'incidentId');
    assertJsonObject(patch, 'patch');

    if (patch.status !== undefined) {
      assertId(patch.status, 'status');
    }
    if (patch.data !== undefined) {
      assertJsonObject(patch.data);
    }
    if (patch.pendingDelivery !== undefined) {
      assertBoolean(patch.pendingDelivery, 'pendingDelivery');
    }
    if (patch.pendingUnban !== undefined) {
      assertBoolean(patch.pendingUnban, 'pendingUnban');
    }
    if (patch.unbanAttempts !== undefined) {
      assertTimestamp(patch.unbanAttempts, 'unbanAttempts');
    }
    if (patch.nextUnbanAttemptAt !== undefined) {
      assertTimestamp(patch.nextUnbanAttemptAt, 'nextUnbanAttemptAt', { nullable: true });
    }

    return this.transactions.updateIncident(incidentId, patch);
  }

  scheduleUnbanRetry(incidentId, { nextAttemptAt = Date.now(), data = {} } = {}) {
    assertId(incidentId, 'incidentId');
    assertTimestamp(nextAttemptAt, 'nextAttemptAt');
    assertJsonObject(data);

    const current = this.getIncident(incidentId);
    if (!current) {
      throw new Error(`Incident ${incidentId} does not exist`);
    }

    return this.updateIncident(incidentId, {
      status: 'unban_pending',
      data,
      pendingDelivery: true,
      pendingUnban: true,
      unbanAttempts: current.unbanAttempts + 1,
      nextUnbanAttemptAt: nextAttemptAt,
    });
  }

  completeIncident(incidentId, { status = 'completed', data = {} } = {}) {
    assertId(incidentId, 'incidentId');
    assertId(status, 'status');
    assertJsonObject(data);
    return this.transactions.completeIncident(incidentId, status, data);
  }

  markIncidentLogDelivered(incidentId) {
    assertId(incidentId, 'incidentId');
    const result = this.statements.markDelivered.run(Date.now(), incidentId);
    if (result.changes === 0) {
      throw new Error(`Incident ${incidentId} does not exist`);
    }
    return this.getIncident(incidentId);
  }

  listPendingIncidentLogs({ guildId = null, limit = 100 } = {}) {
    assertLimit(limit);
    if (guildId !== null) {
      assertId(guildId, 'guildId');
      return this.statements.listPendingLogsForGuild.all(guildId, limit).map(toIncident);
    }

    return this.statements.listPendingLogs.all(limit).map(toIncident);
  }

  listPendingUnbans({ now = Date.now(), limit = 100 } = {}) {
    assertTimestamp(now, 'now');
    assertLimit(limit);
    return this.statements.listPendingUnbans.all(now, limit).map(toIncident);
  }

  saveMessageSnapshot({
    guildId,
    messageId,
    channelId,
    sentAt = Date.now(),
    capturedAt = Date.now(),
    data = {},
  }) {
    assertId(guildId, 'guildId');
    assertId(messageId, 'messageId');
    assertId(channelId, 'channelId');
    assertTimestamp(sentAt, 'sentAt');
    assertTimestamp(capturedAt, 'capturedAt');
    assertJsonObject(data);

    this.#ensureGuildRow(guildId, capturedAt);
    this.statements.upsertSnapshot.run({
      guildId,
      messageId,
      channelId,
      sentAt,
      capturedAt,
      expiresAt: capturedAt + MESSAGE_RETENTION_MS,
      dataJson: serialize(data),
    });
    return this.getMessageSnapshot(guildId, messageId, capturedAt);
  }

  getMessageSnapshot(guildId, messageId, now = Date.now()) {
    assertId(guildId, 'guildId');
    assertId(messageId, 'messageId');
    assertTimestamp(now, 'now');
    return toSnapshot(this.statements.getSnapshot.get(guildId, messageId, now));
  }

  deleteMessageSnapshot(guildId, messageId) {
    assertId(guildId, 'guildId');
    assertId(messageId, 'messageId');
    return this.statements.deleteSnapshot.run(guildId, messageId).changes === 1;
  }

  setLastDeletedMessage(guildId, data, deletedAt = Date.now()) {
    assertId(guildId, 'guildId');
    assertJsonObject(data);
    assertTimestamp(deletedAt, 'deletedAt');

    this.#ensureGuildRow(guildId, deletedAt);
    this.statements.upsertLastDeleted.run(guildId, deletedAt, serialize(data));
    return this.getLastDeletedMessage(guildId);
  }

  recordDeletedMessage({
    guildId,
    messageId,
    deletedAt = Date.now(),
    data = {},
  }) {
    assertId(guildId, 'guildId');
    assertId(messageId, 'messageId');
    assertTimestamp(deletedAt, 'deletedAt');
    assertJsonObject(data);
    return this.transactions.recordDeleted(guildId, messageId, deletedAt, data);
  }

  getLastDeletedMessage(guildId) {
    assertId(guildId, 'guildId');
    return toLastDeleted(this.statements.getLastDeleted.get(guildId));
  }

  pruneExpiredSnapshots(now = Date.now()) {
    assertTimestamp(now, 'now');
    return this.statements.pruneSnapshots.run(now).changes;
  }

  close() {
    if (this.connection.open) {
      this.connection.close();
    }
  }
}

export default Database;
