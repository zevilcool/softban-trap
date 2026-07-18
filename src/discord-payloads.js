import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
} from "discord.js";

const FIELD_LIMIT = 1_024;

function truncate(value, limit = FIELD_LIMIT) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function discordTimestamp(isoString) {
  const milliseconds = Date.parse(isoString);
  if (!Number.isFinite(milliseconds)) return "Unknown";
  return `<t:${Math.floor(milliseconds / 1_000)}:F>`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
}

function attachmentLines(attachments = []) {
  if (attachments.length === 0) return "None";
  return attachments
    .map((attachment) => {
      const name = attachment.name || "unnamed attachment";
      const type = attachment.contentType || "unknown type";
      return `${name} (${type}, ${formatBytes(attachment.size)})\n${attachment.url}`;
    })
    .join("\n");
}

function roleLines(roles = []) {
  if (roles.length === 0) return "None";
  return roles.map((role) => `${role.name || "Unknown role"} (${role.id})`).join("\n");
}

function userLabel(user = {}) {
  const tag = user.tag || user.displayName || "Unknown user";
  return `${tag}\nID: ${user.id || "Unknown"}`;
}

function fullDetailFiles(message, roles) {
  const files = [];
  const content = message?.content || "";
  const roleSections = [
    ["Roles Before Action", roleLines(roles?.original)],
    ["Roles Removed", roleLines(roles?.removed)],
    ["Roles Restored", roleLines(roles?.restored)],
    ["Restore Failures", roleLines(roles?.restoreFailed)],
  ];
  const allRoles = roleSections.flatMap(([heading, value]) => [heading, value, ""]).join("\n");
  const allAttachments = attachmentLines(message?.attachments);

  if (content.length > FIELD_LIMIT) {
    files.push(
      new AttachmentBuilder(Buffer.from(content, "utf8"), {
        name: `message-${message.messageId || "unknown"}.txt`,
      }),
    );
  }

  if (allRoles.length > 1_500 || allAttachments.length > 600) {
    const details = [allRoles, "Attachments", allAttachments].join("\n");
    files.push(
      new AttachmentBuilder(Buffer.from(details, "utf8"), {
        name: `incident-${message?.messageId || "unknown"}-details.txt`,
      }),
    );
  }

  return files;
}

// Cuztomizable
export function buildWarningPayload(count) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("Do Not Send Messages Here")
    .setDescription(
      "Sending any message in this channel will remove your roles, ban you, and immediately unban you. You will need an invite link to rejoin. Administrator, server-owner, and role-hierarchy exemptions are logged",
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("softban-count")
      .setLabel(`Softbanned: ${count}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  return {
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  };
}

export function buildHelpPayload() {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("Softban Bot Commands")
    .addFields(
      { name: "/setup", value: "Create or show this server's public trap channel. Administrator only" },
      { name: "/logs", value: "Create or show the private moderation log channel. Administrator only" },
      { name: "/lsdlt", value: "Show the latest deleted message observed in this server. Administrator only" },
      { name: "/help", value: "Show this" },
    );

  return { embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } };
}

export function buildIncidentLogPayload(incident) {
  const status = incident.status || "failed";
  const style = {
    success: [Colors.Green, "Softban Completed"],
    recovered: [Colors.Green, "Softban Recovery Completed"],
    skipped: [Colors.Yellow, "Softban Skipped"],
    role_removal_attempting: [Colors.Red, "Role State Check Pending"],
    roles_removed: [Colors.Red, "Role Restoration Pending"],
    ban_attempting: [Colors.Red, "Ban State Check Pending"],
    unban_pending: [Colors.Red, "Unban Recovery Required"],
    failed: [Colors.Red, "Softban Failed"],
  }[status] || [Colors.Grey, "Softban Incident"];

  const message = incident.message || {};
  const roles = incident.roles || {};
  const content = message.contentAvailable === false
    ? "Content unavailable"
    : message.content || "No text content";
  const originalRoles = roleLines(roles.original);
  const removedRoles = roleLines(roles.removed);
  const restoredRoles = roleLines(roles.restored);
  const restoreFailures = roleLines(roles.restoreFailed);
  const attachments = attachmentLines(message.attachments);
  const operationalErrors = [
    incident.error,
    incident.roleRemovalWarning,
    incident.messageDeleteError,
    incident.counterMessageError,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor(style[0])
    .setTitle(style[1])
    .addFields(
      { name: "User", value: truncate(userLabel(incident.user), 200), inline: true },
      { name: "Incident", value: truncate(incident.id || "Unknown", 64), inline: true },
      { name: "Reason", value: truncate(incident.reason || "Trap channel message", 400) },
      {
        name: "Message",
        value: truncate(content, 800),
      },
      {
        name: "Location And Time",
        value: truncate(
          `Channel: ${message.channel?.name || "Unknown"} (${message.channel?.id || "Unknown"})\nMessage: ${message.messageId || "Unknown"}\nSent: ${discordTimestamp(message.sentAt)}`,
          320,
        ),
      },
      { name: "Roles Before Action", value: truncate(originalRoles, 600) },
      { name: "Roles Removed", value: truncate(removedRoles, 400), inline: true },
      { name: "Roles Restored", value: truncate(restoredRoles, 400), inline: true },
      { name: "Restore Failures", value: truncate(restoreFailures, 400), inline: true },
      { name: "Attachments", value: truncate(attachments, 600) },
    )
    .setFooter({ text: `Status: ${status}` })
    .setTimestamp(new Date(incident.updatedAt || incident.createdAt || Date.now()));

  const preview = message.attachments?.find((attachment) =>
    attachment.contentType?.toLowerCase().startsWith("image/") && attachment.url,
  );
  if (preview) embed.setImage(preview.url);

  if (operationalErrors) {
    embed.addFields({ name: "Operational Errors", value: truncate(operationalErrors, 500) });
  }

  return {
    embeds: [embed],
    files: fullDetailFiles(message, roles),
    allowedMentions: { parse: [] },
  };
}

export function buildLastDeletedPayload(record) {
  const message = record?.snapshot || {};
  const content = message.contentAvailable === false
    ? "Content unavailable"
    : message.content || "No text content";
  const attachments = attachmentLines(message.attachments);
  const bulkText = record?.bulkDeleteCount > 1
    ? `Part of a bulk deletion containing ${record.bulkDeleteCount} messages.\n`
    : "";

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle("Last Deleted Message")
    .addFields(
      { name: "Author", value: truncate(userLabel(message.author)), inline: true },
      {
        name: "Channel",
        value: truncate(`${message.channel?.name || "Unknown"}\nID: ${message.channel?.id || "Unknown"}`),
        inline: true,
      },
      { name: "Content", value: truncate(content) },
      {
        name: "Timestamps",
        value: `${bulkText}Sent: ${discordTimestamp(message.sentAt)}\nDeleted: ${discordTimestamp(record?.deletedAt)}`,
      },
      { name: "Attachments", value: truncate(attachments) },
    )
    .setFooter({ text: `Message ID: ${message.messageId || "Unknown"}` });

  const preview = message.attachments?.find((attachment) =>
    attachment.contentType?.toLowerCase().startsWith("image/") && attachment.url,
  );
  if (preview) embed.setImage(preview.url);

  const files = [];
  if (content.length > FIELD_LIMIT) {
    files.push(
      new AttachmentBuilder(Buffer.from(content, "utf8"), {
        name: `deleted-message-${message.messageId || "unknown"}.txt`,
      }),
    );
  }

  return { embeds: [embed], files, ephemeral: true, allowedMentions: { parse: [] } };
}
