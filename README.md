# VEX Snake Draft Bot

A production-ready Discord bot for running **snake drafts of VEX Robotics teams** at
robotics events: configurable rounds and picks, auto-skip timers with active hours,
prepicks, team-for-team / 2-for-1 / future-pick trades with an approval workflow, admin
corrections, a complete audit log and durable state that survives restarts.

* **Stack:** TypeScript, discord.js v14, SQLite (better-sqlite3, WAL), luxon, pino, vitest.
* **Design:** a Discord-independent draft engine, a repository layer over SQLite, a
  service layer with per-draft locking and durable timers, and a thin Discord command/UI
  layer. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
* **Setup guide:** [docs/SETUP.md](docs/SETUP.md) walks through creating the Discord
  application, intents, permissions, database, starting the bot, importing teams and
  running the first draft.

## Quick start

```bash
cp .env.example .env         # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
npm install
npm run build
npm start                    # registers slash commands and connects
```

For development: `npm run dev` (tsx watch), `npm test`, `npm run lint`, `npm run typecheck`.

## Commands

### Admin (`/draft …`)

Requires **Manage Server** / **Administrator**, or the role set with `/draft config admin-role`.
Every admin command is validated server-side, not just hidden.

| Command | Purpose |
| --- | --- |
| `/draft setup [name]` | Create a new draft (one open draft per server). |
| `/draft channel set [channel] [post-title]` | Choose the text channel, thread or forum post for announcements. Picking a **forum** creates a new post. |
| `/draft import file:<csv> [mode]` | Import teams from CSV (column detection, duplicate/invalid reporting). |
| `/draft team add / remove / restore / list / limit` | Manage the team pool. `remove force:true` also drops the team from rosters; `limit team times` sets how many times one specific team can be picked (overrides `config team-instances`). |
| `/draft participant add user [user2…user5] [label] [seat]` | Register a participant. List several users to register them as one **team**: every member can pick, prepick and trade for it and all are pinged on its turn. With `seat`, add the users to an existing team at any time, even mid-draft or after it (late joiners). |
| `/draft participant remove seat [user]` | Remove a seat, or just one user from it. |
| `/draft config view` | Show the full configuration. |
| `/draft config rounds / picks-per-round / participants / snake` | Draft structure (locked once started). |
| `/draft config skip-time / skip-hours / timezone` | Auto-skip timer, e.g. `15m`, `09:00 22:00`, `America/Chicago`. |
| `/draft config prepicks / after-skip / pick-confirmation / swaps` | Prepick mode, catch-up policy, confirm button on `/pick`, whether `/swap` is allowed. |
| `/draft config trades / two-for-one / future-picks / trade-approval / post-draft-trades` | Trade rules. |
| `/draft config team-instances / seats-per-user / roster-size` | Duplicate team copies, multi-seat users, roster caps. |
| `/draft randomize` | Securely shuffle the order (crypto RNG) and show it with a **Start draft** button. |
| `/draft start [confirm]` | Validate, lock structural settings, materialize the pick order, ping the first player, start the timer. |
| `/draft skip` | Force-skip the player on the clock. |
| `/draft pick force team [participant]` | Enter a pick on someone's behalf. |
| `/draft pick correct pick team` | Change the team at an overall pick number (history preserved). |
| `/draft roster add / replace / drop / move` | Live roster interventions. |
| `/draft trade approve / deny / list` | Admin approval workflow. |
| `/draft repick start participant team [reason]` | A drafted team no-showed: remove it and let the drafter choose a replacement (keeps the pick number). |
| `/draft repick approve / deny / cancel / list` | Admins approve every repick; deny sends the drafter back to choose again. |
| `/draft sheet set url [tab]` / `sync` / `view` / `clear` | Mirror the draft to a Google Sheet (drafter rows with Pick 1..N, available-teams grid, status). Updated after every change. |
| `/draft complete` | End the draft early. |
| `/draft reset [purge]` | Wipe the draft (archive by default; `purge` deletes rows, audit kept). Requires confirmation. |
| `/draft audit [limit]` | Recent audit events. |

### Everyone

| Command | Purpose |
| --- | --- |
| `/status` | Draft state: round, overall pick, current player, time remaining, available teams, roster count. Buttons for roster, prepicks, order. |
| `/pick team [seat]` | Pick when it is your turn, fill your skipped pick (catch-up), or choose a replacement for an open repick. |
| `/repick choose team [id]` / `view` | Choose the replacement for a repick an admin opened for your team. |
| `/prepicks add / remove / view / reorder / clear` | Ordered auto-pick list. The bot picks the first available team when your turn comes. |
| `/roster [user] [seat] [all]` | Rosters with pick numbers, rounds, original owners and trades. |
| `/team number` | Availability and every owner instance with pick number, round and trade flag. |
| `/swap old-team new-team [seat]` | Swap one of your own teams for any unpicked team, immediately, keeping the pick number. Admins can turn this off with `/draft config swaps`. |
| `/teams [filter] [names]` | The pool of teams still available, as a paged number grid (copies left shown as ×n) or a list with names and schools. |
| `/trade propose with give receive [note]` | Propose a trade. Assets: `1234A`, `R3` (your round-3 pick), `#17` (overall pick). |
| `/trade accept / reject / cancel / view / list` | Answer and inspect trades (buttons are posted in the draft channel too). |

## Google Sheets mirror

With a Google service account configured (`GOOGLE_SERVICE_ACCOUNT_FILE`), `/draft sheet set`
links a spreadsheet and the bot rewrites one tab after every pick, skip, trade and admin
change: a row per drafter with `Pick 1 … Pick N`, the available-team grid, picks per team
and the current status. The sheet is a read-only mirror; the bot remains the source of truth.
Setup steps are in [docs/SETUP.md](docs/SETUP.md#7-google-sheets-mirror-optional).

## How the draft runs

1. **Setup → randomized → active → completed.** Adding or removing participants after
   randomizing clears the order. Starting locks rounds, picks per round, snake order and
   seats per user.
2. **Each slot** (round, overall pick) is owned by the participant who holds its pick
   asset. Future-pick trades move the asset; the pick number never changes.
3. **Turn start:** the owner is pinged and the timer is armed. With prepicks in
   `immediate` mode the bot auto-picks the first available prepick right away; in
   `on_timeout` mode it does so only when the timer expires.
4. **Timer expiry** auto-skips (recorded in history and announced). With
   `after-skip = catch_up` the skipped player may `/pick` later to fill that slot; with
   `forfeit` the pick is lost. Timers only count down inside the configured hours.
5. **Completion** happens when every slot is resolved or the team pool is empty; open
   skipped slots are forfeited.

## Reliability

* Every pick, skip, trade and admin change runs inside one `BEGIN IMMEDIATE` SQLite
  transaction with validation inside the transaction, so two simultaneous picks of the
  same team cannot both succeed (covered by an in-process test and a six-process race test).
* Timer callbacks carry a per-turn token and are no-ops once the turn has resolved.
* A per-draft mutex serializes command handling, timer callbacks and announcements.
* Turn deadlines are persisted; on restart they are re-armed and overdue ones fire
  immediately. A 60-second sweep catches lost timeouts.
* Audit events are written in the same transaction as the change they describe.

## Project layout

```
src/domain      types, errors, snake order, config rules, active-hours math
src/db          connection, migrations, repositories
src/engine      draft engine, trade engine, prepicks, CSV import
src/services    locking, timers, announcements, draft service
src/discord     commands, components, views, permissions, client
tests           unit + integration (engine, trades, timers, recovery, concurrency)
```
