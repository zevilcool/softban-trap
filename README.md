# Discord Softban Trap Bot

This bot creates a public warning channel that strips a member's roles, bans them, and immediately unbans them when they send a message. It keeps private moderation logs, a persistent success counter, and a seven-day deleted-message cache for `/lsdlt`

## Requirements

- Node.js 24
- A Discord application and bot token
- A server where you can grant the bot the permissions listed below

Enable these privileged gateway intents on the **Developer Portal > Bot** page:

- Server Members Intent
- Message Content Intent

Invite the bot with the `bot` and `applications.commands` scopes. Grant these bot permissions:

- Manage Channels
- Manage Roles
- Manage Messages
- Ban Members
- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files

### UNRECOMMENDED
Do not grant the bot Administrator.

### RECOMMENDED 
Move the bot's highest role above every non-administrator member it should moderate

## Install

Run these commands from the extracted project directory:

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` with the application values:

```dotenv
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_ID=your_test_server_id
DATABASE_PATH=./data/bot.sqlite
```

`GUILD_ID` is optional. Use it for ur own server, it will register commands immediately in one server. Remove it to register global commands, which Discord may take time to publish

Register the commands and start the bot:

```powershell
npm run register
npm start
```

Never commit or share `.env`. The supplied ZIP does not contain a token, runtime database, or moderation logs

## Commands

### `/setup`

Administrator-only. Creates one root-level text channel with a random 12-character name. Running it again reuses the configured channel and restores its permission overwrites

The channel explicitly allows `@everyone` to view it, send messages, read history, and attach files. It disables thread creation. Discord timeouts, membership screening, and server-wide restrictions can still stop a member from chatting

The bot posts a warning embed with a disabled `Softbanned: <number>` button. If that message is deleted, the bot recreates it without resetting the counter.

### `/logs`

Administrator-only. Creates or restores `softbanned-logs`. The channel denies access to `@everyone`; members with Discord's Administrator permission can still view it. Running the command also delivers incident logs queued while the channel was unavailable

Each incident records:

- User ID and current tag
- Trigger message, channel, and send time
- Original, removed, restored, and failed-to-restore roles
- Attachment names, types, sizes, URLs, and an inline preview for the first image
- Success, exemption, failure, or recovery status

Copied message content cannot ping members. Long content and role details are added as text files when they exceed embed limits

### `/help`

Available to everyone in a server. Responds privately with the command list

### `/lsdlt`

Administrator-only. Responds privately with the latest deleted message observed in that server, including attachment metadata and bulk-deletion information

The bot stores message snapshots for seven days and keeps the latest deletion record until another deletion replaces it. Discord cannot provide messages that were both sent and deleted while the bot was offline. Attachment CDN URLs may expire; the bot does not archive attachment binaries

## Moderation Flow

1. The bot captures the trigger message, attachments, member ID, and roles.
2. It deletes only the triggering message.
3. It skips and logs server owners, administrators, members at or above the bot's highest role, and members Discord reports as unmanageable or unbannable.
4. It removes every editable, non-managed role.
5. It bans with zero history deletion, then immediately unbans the member.
6. It increments the counter only after the unban succeeds.

The member leaves the server during the ban and needs an invite to rejoin. Discord never removes `@everyone`. Integration-managed roles cannot be explicitly stripped, but leaving the server removes the membership that held them

The bot records the intended role removal before calling Discord. If the API response is lost, it fetches the member's current roles and either continues from confirmed server state or restores the missing roles after a restart. If repeated ban attempts fail after roles were removed, the bot tries to restore each removed role and logs any failure. If the ban succeeds but the unban fails, SQLite records the pending recovery before the bot retries. Recovery continues after restarts, and the counter remains unchanged until the member is unbanned

## Data And Recovery

The SQLite database defaults to `data/bot.sqlite` and uses WAL mode. It stores:

- One trap channel, warning message, log channel, and counter per server
- Moderation incidents and pending log delivery
- Pending unban recovery
- Seven-day message snapshots and the latest deleted message per server

Keep the `data` directory on persistent storage when running the bot under a process manager or container. Deleting it resets configuration, counters, recovery state, and deleted-message history.

## Development

```powershell
npm run lint
npm test
npm run check
```
