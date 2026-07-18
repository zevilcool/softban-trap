const DISCORD_EPOCH = 1_420_070_400_000n;

function safeGet(value, key) {
  if (value == null) return undefined;

  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function toId(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toStringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIso(value) {
  if (value == null) return null;

  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function snowflakeTimestamp(id) {
  if (typeof id !== "string" || !/^\d+$/.test(id)) return null;

  try {
    const milliseconds = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
    return toIso(milliseconds);
  } catch {
    return null;
  }
}

function collectionValues(collection) {
  if (collection == null || typeof collection === "string") return [];
  if (Array.isArray(collection)) return collection.slice();

  const values = safeGet(collection, "values");
  if (typeof values === "function") {
    try {
      return Array.from(values.call(collection));
    } catch {
      // Fall through to other collection shapes
    }
  }

  const iterator = safeGet(collection, Symbol.iterator);
  if (typeof iterator === "function") {
    try {
      return Array.from(collection);
    } catch {
      // Fall through to plain objects
    }
  }

  if (typeof collection === "object") {
    try {
      return Object.values(collection);
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeAttachment(attachment) {
  const name = toStringOrNull(safeGet(attachment, "name"));
  const explicitSpoiler = safeGet(attachment, "spoiler");

  return {
    id: toId(safeGet(attachment, "id")),
    name,
    url: toStringOrNull(safeGet(attachment, "url")),
    contentType: toStringOrNull(safeGet(attachment, "contentType")),
    size: toNumberOrNull(safeGet(attachment, "size")),
    width: toNumberOrNull(safeGet(attachment, "width")),
    height: toNumberOrNull(safeGet(attachment, "height")),
    spoiler:
      typeof explicitSpoiler === "boolean"
        ? explicitSpoiler
        : typeof name === "string" && name.startsWith("SPOILER_"),
  };
}

function normalizeSticker(sticker) {
  const format = safeGet(sticker, "format") ?? safeGet(sticker, "formatType");
  const rawTags = safeGet(sticker, "tags");

  return {
    id: toId(safeGet(sticker, "id")),
    name: toStringOrNull(safeGet(sticker, "name")),
    description: toStringOrNull(safeGet(sticker, "description")),
    tags: Array.isArray(rawTags)
      ? rawTags.map(String)
      : typeof rawTags === "string"
        ? rawTags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : [],
    format:
      typeof format === "string" || typeof format === "number" ? format : null,
    url: toStringOrNull(safeGet(sticker, "url")),
  };
}

function authorTag(author) {
  const explicitTag = toStringOrNull(safeGet(author, "tag"));
  if (explicitTag) return explicitTag;

  const username = toStringOrNull(safeGet(author, "username"));
  const discriminator = toStringOrNull(safeGet(author, "discriminator"));
  if (username && discriminator && discriminator !== "0") {
    return `${username}#${discriminator}`;
  }

  return username;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

/**
 * Convert a discord.js Message (including a partial Message) into JSON-safe data
 */
export function serializeMessage(message) {
  const guild = safeGet(message, "guild");
  const channel = safeGet(message, "channel");
  const channelGuild = safeGet(channel, "guild");
  const author = safeGet(message, "author");
  const member = safeGet(message, "member");

  const messageId = toId(
    firstPresent(safeGet(message, "id"), safeGet(message, "messageId")),
  );
  const rawContent = safeGet(message, "content");
  const explicitContentAvailable = safeGet(message, "contentAvailable");
  const contentAvailable =
    typeof rawContent === "string" && explicitContentAvailable !== false;

  const createdValue = firstPresent(
    safeGet(message, "createdAt"),
    safeGet(message, "createdTimestamp"),
    safeGet(message, "sentAt"),
  );
  const editedValue = firstPresent(
    safeGet(message, "editedAt"),
    safeGet(message, "editedTimestamp"),
  );

  const authorExists = author != null || safeGet(message, "authorId") != null;
  const authorBot = firstPresent(
    safeGet(author, "bot"),
    safeGet(message, "authorBot"),
  );
  const guildId = toId(
    firstPresent(
      safeGet(message, "guildId"),
      safeGet(guild, "id"),
      safeGet(channel, "guildId"),
      safeGet(channelGuild, "id"),
    ),
  );
  const guildName = toStringOrNull(
    firstPresent(
      safeGet(guild, "name"),
      safeGet(channelGuild, "name"),
      safeGet(message, "guildName"),
    ),
  );
  const channelId = toId(
    firstPresent(safeGet(message, "channelId"), safeGet(channel, "id")),
  );
  const channelName = toStringOrNull(
    firstPresent(safeGet(channel, "name"), safeGet(message, "channelName")),
  );
  const authorId = toId(
    firstPresent(safeGet(author, "id"), safeGet(message, "authorId")),
  );
  const resolvedAuthorTag = toStringOrNull(
    firstPresent(authorTag(author), safeGet(message, "authorTag")),
  );
  const authorDisplayName = toStringOrNull(
    firstPresent(
      safeGet(member, "displayName"),
      safeGet(member, "nickname"),
      safeGet(author, "globalName"),
      safeGet(author, "displayName"),
      safeGet(author, "username"),
      safeGet(message, "authorDisplayName"),
    ),
  );
  const resolvedAuthorBot =
    authorExists && typeof authorBot === "boolean" ? authorBot : null;

  return {
    guild: { id: guildId, name: guildName },
    channel: { id: channelId, name: channelName },
    messageId,
    author: {
      id: authorId,
      tag: resolvedAuthorTag,
      displayName: authorDisplayName,
      bot: resolvedAuthorBot,
    },
    content: contentAvailable ? rawContent : null,
    sentAt: toIso(createdValue) ?? snowflakeTimestamp(messageId),
    editedAt: toIso(editedValue),
    attachments: collectionValues(safeGet(message, "attachments")).map(
      normalizeAttachment,
    ),
    stickers: collectionValues(safeGet(message, "stickers")).map(
      normalizeSticker,
    ),
    contentAvailable,
  };
}

function coerceSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (typeof snapshot !== "string") return snapshot;

  try {
    const parsed = JSON.parse(snapshot);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function snapshotValue(snapshot, key) {
  const nestedFields = {
    guildId: ["guild", "id"],
    guildName: ["guild", "name"],
    channelId: ["channel", "id"],
    channelName: ["channel", "name"],
    authorId: ["author", "id"],
    authorTag: ["author", "tag"],
    authorDisplayName: ["author", "displayName"],
    authorBot: ["author", "bot"],
  };
  const nestedPath = nestedFields[key];

  if (nestedPath) {
    const nested = safeGet(safeGet(snapshot, nestedPath[0]), nestedPath[1]);
    return firstPresent(nested, safeGet(snapshot, key));
  }

  return safeGet(snapshot, key);
}

function preferLive(live, stored, key) {
  return firstPresent(snapshotValue(live, key), snapshotValue(stored, key));
}

/**
 * Merge a deletion event with an earlier snapshot. Partial event fields fall back
 * to the stored copy, while event data remains authoritative
 */
export function mergeDeletedMessage(message, storedSnapshot) {
  const live = serializeMessage(message);
  const stored = coerceSnapshot(storedSnapshot);
  if (!stored) return live;

  const storedContent = snapshotValue(stored, "content");
  const storedAvailability = snapshotValue(stored, "contentAvailable");
  const storedContentAvailable =
    storedAvailability === true ||
    (storedAvailability !== false && typeof storedContent === "string");
  const contentAvailable = live.contentAvailable || storedContentAvailable;

  const isPartial = safeGet(message, "partial") === true;
  const liveAttachmentsSource = safeGet(message, "attachments");
  const liveStickersSource = safeGet(message, "stickers");
  const attachmentsKnown =
    liveAttachmentsSource != null && (!isPartial || live.attachments.length > 0);
  const stickersKnown =
    liveStickersSource != null && (!isPartial || live.stickers.length > 0);

  const storedAttachments = collectionValues(
    snapshotValue(stored, "attachments"),
  ).map(normalizeAttachment);
  const storedStickers = collectionValues(snapshotValue(stored, "stickers")).map(
    normalizeSticker,
  );
  const guildId = toId(preferLive(live, stored, "guildId"));
  const guildName = toStringOrNull(preferLive(live, stored, "guildName"));
  const channelId = toId(preferLive(live, stored, "channelId"));
  const channelName = toStringOrNull(preferLive(live, stored, "channelName"));
  const authorId = toId(preferLive(live, stored, "authorId"));
  const authorTag = toStringOrNull(preferLive(live, stored, "authorTag"));
  const authorDisplayName = toStringOrNull(
    preferLive(live, stored, "authorDisplayName"),
  );
  const authorBotValue = preferLive(live, stored, "authorBot");
  const authorBot =
    typeof authorBotValue === "boolean" ? authorBotValue : null;

  return {
    guild: { id: guildId, name: guildName },
    channel: { id: channelId, name: channelName },
    messageId: toId(preferLive(live, stored, "messageId")),
    author: {
      id: authorId,
      tag: authorTag,
      displayName: authorDisplayName,
      bot: authorBot,
    },
    content: live.contentAvailable
      ? live.content
      : storedContentAvailable
        ? storedContent
        : null,
    sentAt: toIso(preferLive(live, stored, "sentAt")),
    editedAt: toIso(preferLive(live, stored, "editedAt")),
    attachments: attachmentsKnown ? live.attachments : storedAttachments,
    stickers: stickersKnown ? live.stickers : storedStickers,
    contentAvailable,
  };
}

function lookupStoredSnapshot(storedLookup, id, message) {
  if (storedLookup == null || id == null) return null;

  if (typeof storedLookup === "function") {
    try {
      return storedLookup(id, message) ?? null;
    } catch {
      return null;
    }
  }

  const get = safeGet(storedLookup, "get");
  if (typeof get === "function") {
    try {
      return get.call(storedLookup, id) ?? null;
    } catch {
      return null;
    }
  }

  if (typeof storedLookup === "object") {
    try {
      return storedLookup[id] ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

function compareIds(left, right) {
  const leftNumeric = typeof left === "string" && /^\d+$/.test(left);
  const rightNumeric = typeof right === "string" && /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const leftSnowflake = BigInt(left);
    const rightSnowflake = BigInt(right);
    return leftSnowflake < rightSnowflake
      ? -1
      : leftSnowflake > rightSnowflake
        ? 1
        : 0;
  }

  if (leftNumeric !== rightNumeric) return leftNumeric ? 1 : -1;
  return String(left).localeCompare(String(right));
}

/**
 * Select the most recent message from a bulk deletion event by snowflake ID.
 * The returned snapshot includes the total number of messages in the event
 */
export function chooseLatestBulkSnapshot(messages, storedLookup) {
  const deletedMessages = collectionValues(messages);
  let latest = null;

  for (const message of deletedMessages) {
    const messageId = toId(
      firstPresent(safeGet(message, "id"), safeGet(message, "messageId")),
    );
    const snapshot = mergeDeletedMessage(
      message,
      lookupStoredSnapshot(storedLookup, messageId, message),
    );

    if (
      snapshot.messageId != null &&
      (latest == null || compareIds(snapshot.messageId, latest.messageId) > 0)
    ) {
      latest = snapshot;
    }
  }

  return latest == null ? null : { ...latest, bulkCount: deletedMessages.length };
}
