# Setup guide

## 1. Create the Discord application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and
   click **New Application**. Name it (e.g. "VEX Draft Bot").
2. **General Information → Application ID**: copy it into `DISCORD_CLIENT_ID`.
3. **Bot** tab → **Reset Token** → copy the token into `DISCORD_TOKEN`. Never commit it.
4. **Bot → Privileged Gateway Intents:** none are required. The bot only uses the
   `Guilds` intent (slash commands and components arrive through the interactions
   gateway; announcements are ordinary channel messages). Leave *Presence*, *Server
   Members* and *Message Content* off.
5. **Installation** (or **OAuth2 → URL Generator**): choose the `bot` and
   `applications.commands` scopes and the permissions below, then open the generated
   URL to invite the bot to your server.

### Required bot permissions

| Permission | Why |
| --- | --- |
| View Channels | Read the draft channel/thread. |
| Send Messages | Announce picks, skips, trades, turn pings. |
| Send Messages in Threads | Forum posts and threads are threads. |
| Create Public Threads | Needed only if you let `/draft channel set` create a forum post. |
| Embed Links | Status, roster and trade embeds. |
| Read Message History | Edit trade messages (remove buttons once resolved). |
| Manage Threads | Reopen an auto-archived draft thread (optional but recommended). |
| Mention Everyone | **Not** needed; the bot only mentions the specific users it pings. |

Permission integer for the set above (without Mention Everyone): `326417590272`.

Slash-command visibility: `/draft` is marked with the *Manage Server* default
permission so regular members do not see it. The bot additionally checks permissions on
every call, so even if a server admin loosens the command permissions in **Server
Settings → Integrations**, only Manage Server / Administrator members or holders of the
configured admin role can run admin commands.

## 2. Configure the environment

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `DISCORD_CLIENT_ID` | yes | Application ID. |
| `DISCORD_GUILD_ID` | no | Register commands only in this server (instant updates). Leave empty for global registration (up to an hour to propagate). |
| `REGISTER_COMMANDS_ON_START` | no | `true` (default) registers commands every boot. |
| `DATABASE_PATH` | no | SQLite file, default `./data/draft.db`. The directory is created automatically. |
| `LOG_LEVEL` | no | `trace`…`fatal`, default `info`. |
| `LOG_PRETTY` | no | Human-readable logs for development. |
| `DEFAULT_TIMEZONE` | no | IANA zone used for new drafts, e.g. `America/New_York`. |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | no | Service-account JSON key path; enables the Google Sheets mirror. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | The key JSON inline, instead of a file. |
| `SHEET_SYNC_DEBOUNCE_MS` | no | Delay before writing after a change (default 1500). |

## 3. Database

SQLite needs no server. On first start the bot creates the file and applies migrations
(`src/db/migrations.ts`). WAL mode is enabled, so make sure the directory is writable
and back up `draft.db`, `draft.db-wal` and `draft.db-shm` together (or run
`sqlite3 draft.db ".backup backup.db"`).

Manual migration (optional): `npm run migrate`.

## 4. Start the bot

```bash
npm install
npm run build
npm start
```

Development: `npm run dev`. Register commands without starting the bot:
`npm run register`.

### Running continuously

Any process manager works. Example `systemd` unit:

```ini
[Unit]
Description=VEX Snake Draft Bot
After=network-online.target

[Service]
WorkingDirectory=/opt/vex-snake-draft-bot
EnvironmentFile=/opt/vex-snake-draft-bot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The bot recovers active drafts and their timers on every restart. Run exactly one
instance per bot token.

Docker:

```Dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
```

## 5. Import teams

Prepare a CSV. The header is detected automatically; common column names work:

```csv
Team Number,Team Name,Organization,City,State
1234A,Robo Lions,Lincoln High School,Austin,TX
5678B,Byte Me,Byte Robotics Club,Dallas,TX
```

Recognized headers: team number (`number`, `team`, `team number`, `id`…), name
(`name`, `team name`, `robot name`…), organization (`organization`, `org`, `school`…),
location (`location`, or `city` + `state`/`region` + `country`). Extra columns are kept
and shown in `/team`. A headerless file is read as `number,name,organization,location`.

Upload it with `/draft import file:<attachment>`. The summary lists imported, updated,
skipped, failed and duplicate rows. Single teams can be added with `/draft team add`.

## 6. Run the first draft

1. `/draft setup name:"Spring Invitational"`
2. `/draft channel set` in the channel, thread or forum post where the draft happens.
   For a forum, pass `channel:#forum post-title:"Draft"` and the bot creates the post.
3. `/draft import file:teams.csv`
4. `/draft participant add user:@alice` for a solo participant, or
   `/draft participant add user:@alice user2:@bob user3:@cara label:"Team 1234A"` to register
   several people as one team that any of them can act for. Use `seat:` to add people to an
   existing seat later.
5. Configure: `/draft config rounds number:8`, `/draft config skip-time duration:15m`,
   `/draft config skip-hours start:09:00 end:22:00`, `/draft config timezone zone:America/Chicago`,
   `/draft config trades enabled:true`, `/draft config future-picks enabled:true` …
   Review with `/draft config view`.
6. `/draft randomize` → check the order → **Start draft**.
7. Players use `/pick`, `/prepicks`, `/roster`, `/team`, `/trade`; everyone can use `/status`.
8. Afterwards `/draft reset` archives the draft so a new one can be set up immediately.

## 7. Google Sheets mirror (optional)

The bot can keep a Google Sheet tab in sync with the draft (one row per drafter with
`Pick 1 … Pick N`, the available-team grid, picks per team and the current status).

1. In [Google Cloud Console](https://console.cloud.google.com/) create (or pick) a project,
   enable the **Google Sheets API**, then create a **Service account** (IAM & Admin →
   Service Accounts → Create). No roles are needed.
2. Open the service account → **Keys → Add key → JSON** and download the key file.
3. Put it next to the bot (for example `./secrets/google-service-account.json`, never commit
   it) and set in `.env`:

   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/google-service-account.json
   ```

   Alternatively paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. Share the spreadsheet with the service account's email (`...@...iam.gserviceaccount.com`)
   as an **Editor**.
5. Restart the bot, then in Discord: `/draft sheet set url:<spreadsheet link> tab:Draft`.
   The bot verifies access, writes the sheet immediately and keeps it updated. Use
   `/draft sheet sync` to force a rewrite and `/draft sheet view` to see the link and the
   last error, if any.

The bot rewrites the whole tab on every change, so keep your own notes on other tabs.

## Troubleshooting

* **Commands do not appear:** confirm `applications.commands` scope was granted; with
  global registration wait up to an hour, or set `DISCORD_GUILD_ID` for instant updates.
* **"The bot needs View Channel, Send Messages…":** adjust channel permissions for the
  bot role, including *Send Messages in Threads* for forum posts.
* **Timer does not skip:** check `/draft config view` for the skip time and active hours;
  the timer pauses outside the configured hours and resumes automatically.
* **Database locked errors:** another process is holding the file; run a single bot instance.
