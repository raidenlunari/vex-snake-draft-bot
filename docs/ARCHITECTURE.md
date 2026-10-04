# Architecture

This document is the design proposal for the VEX Snake Draft bot. It was written
before implementation against an empty repository, so the stack below was chosen
from scratch rather than inherited.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict, ESM, Node 20+) | Strong typing across the engine, repositories and Discord layer. |
| Discord | discord.js v14 | Slash commands, buttons, select menus, forum threads, autocomplete. |
| Database | SQLite via `better-sqlite3` (WAL mode) | A real, durable, transactional database with zero operational overhead for a club-run bot. Transactions are synchronous, which makes every pick/trade/skip a single serialized critical section. |
| Time zones | luxon | Skip-timer active hours are expressed in a configurable IANA zone. |
| Validation | zod (env), explicit domain validators | Clear user-facing error messages. |
| Logging | pino | Structured JSON logs. |
| Tests | vitest | Fast unit + integration tests against in-memory and on-disk SQLite. |

## Layers

```
src/
  index.ts                 entrypoint: env -> db/migrate -> services -> discord client -> timer recovery
  config/env.ts            environment parsing (zod), no secrets in code
  logging/logger.ts        pino logger
  db/
    connection.ts          open database, pragmas (WAL, foreign keys, busy timeout)
    migrations.ts          ordered SQL migrations applied at boot
    repositories/*.ts      thin typed data access, one class per aggregate
  domain/
    types.ts               Draft, DraftConfig, Participant, Team, PickSlot, DraftAsset, Trade, ...
    errors.ts              DraftError (code + user-facing message)
    snakeOrder.ts          pure snake-order generator
    config.ts              DraftConfig defaults, validation, lock rules
    activeHours.ts         skip-timer deadline math across active hours / time zones
  engine/
    draftEngine.ts         picks, skips, advancing, prepick application, admin corrections, start/reset
    tradeEngine.ts         proposal / acceptance / approval / atomic execution
    prepickService.ts      prepick CRUD and reordering
    csvImport.ts           column detection + validation + import summary
  services/
    draftService.ts        orchestrates engine calls under a per-draft lock, announces events, arms timers
    timerService.ts        durable turn timers with restart recovery and a safety sweep
    announcer.ts           sends embeds / pings to the configured channel, forum post or thread
    lock.ts                keyed async mutex
  discord/
    client.ts              discord.js client, interaction routing
    commands/*.ts          slash command definitions + thin handlers (no business logic)
    components/*.ts        button / select-menu handlers
    views/*.ts             embed builders
    permissions.ts         server-side admin / participant checks
    registerCommands.ts    command registration script
```

Rules:

* The Discord layer never touches the database directly and never decides draft
  rules. It parses the interaction, checks permissions, calls a service and
  renders the result.
* The engine is synchronous and runs every mutation inside one
  `BEGIN IMMEDIATE` transaction. Validation happens inside the transaction, so
  two users picking the same team cannot both succeed.
* Every mutating service call is additionally serialized per draft with an
  in-process keyed mutex so announcements and timer re-arming cannot interleave
  with a timer callback.
* Every mutation writes an `audit_events` row in the same transaction.

## Draft assets

Rosters are not a table of their own. Everything a participant can own is a
`draft_assets` row:

* `asset_type = 'team'`: a specific instance of a VEX team (instance numbers
  allow duplicate copies when configured). Carries the slot it was picked in.
* `asset_type = 'pick'`: a draft pick. One is created for every `pick_slots` row
  when the draft starts. The slot (draft, round, overall pick, original owner)
  is immutable; the asset's `current_participant_id` is what trades move.

A roster is "all active team assets currently owned by a participant". A
participant's future picks are "all active pick assets they currently own whose
slot is still pending". The engine asks *who owns the current slot's pick asset*
to decide whose turn it is, so traded picks slot into the snake order without
changing pick numbers.

Trades move asset ownership only. Team-for-team, 2-for-1 and future-pick trades
are the same operation over different asset lists.

## Database schema

```
guild_settings      guild_id PK, admin_role_id
drafts              id, guild_id, name, status(setup|randomized|active|completed|archived),
                    channel_id, channel_kind, parent_channel_id, current_slot_id,
                    turn_token, turn_started_at, turn_deadline_at, version, timestamps
                    UNIQUE(guild_id) WHERE status IN (setup, randomized, active)
draft_configs       draft_id PK, rounds, picks_per_round, snake_order, skip_timer_seconds,
                    skip_hours_start/end, timezone, allow_prepicks, prepick_mode,
                    allow_trades, allow_two_for_one, allow_future_pick_trades, trade_approval,
                    allow_trades_after_completion, after_skip_policy, max_instances_per_team,
                    max_seats_per_user, max_roster_size, require_pick_confirmation, participant_count
participants        id, draft_id, label, draft_position
participant_users   participant_id, draft_id, discord_user_id, role
teams               id, draft_id, team_number, team_name, organization, location, extra_json, removed_at
pick_slots          id, draft_id, overall_pick, round, pick_in_round, turn_in_round, pick_in_turn,
                    original_participant_id, status(pending|current|picked|skipped|forfeited|void)
draft_assets        id, draft_id, asset_type(team|pick), team_id, pick_slot_id, instance_no,
                    original_participant_id, current_participant_id,
                    status(active|consumed|dropped|removed|void), acquired_via
draft_picks         id, draft_id, pick_slot_id, overall_pick, round, participant_id, team_id,
                    asset_id, kind(pick|prepick|forced|catch_up|admin_add|correction), made_by,
                    made_at, voided_at, voided_by, void_reason
prepicks            id, draft_id, participant_id, team_id, priority
trades              id, draft_id, proposer/counterparty participant ids,
                    status(proposed|accepted|executed|rejected|cancelled|denied|failed), ...
trade_assets        trade_id, asset_id, from_participant_id, to_participant_id
asset_transfers     asset_id, from, to, reason(trade|admin_move), trade_id, actor, created_at
audit_events        id, guild_id, draft_id, event_type, actor_id, actor_kind, summary,
                    subject_json, before_json, after_json, created_at
```

Audit rows have no foreign key to `drafts` so they survive a purge reset.

## Draft state machine

```
setup --randomize--> randomized --start--> active --(last slot resolved)--> completed
  ^                     |                   |
  +----(roster change)--+                   +--reset--> archived (or purged)
```

Within `active`, the engine advances slot by slot:

1. The slot owner (current owner of the slot's pick asset) is pinged and the
   skip timer is armed with a fresh `turn_token`.
2. If prepicks are enabled in `immediate` mode, the owner's prepick list is
   consulted first; the first available team is picked automatically.
3. A `/pick`, forced pick, prepick or skip resolves the slot; the engine moves
   to the next pending slot. When none remain (or the team pool is empty) the
   draft completes and any still-open skipped slots are forfeited.
4. `after_skip_policy = catch_up` lets a skipped participant fill their skipped
   slot later with `/pick`, out of turn.

Timer expiry is idempotent: the callback carries the `turn_token` that armed
it and the engine ignores the callback if the token no longer matches.
On restart, every active draft's stored deadline is re-armed; past deadlines
fire immediately. A 60 s safety sweep catches anything a lost timer missed.

## Command structure

Admin (`/draft`, requires Manage Server / Administrator or the configured admin role, validated server-side):

```
/draft setup [name]                    /draft import file:<csv> [mode]
/draft channel set [channel] [title]   /draft channel view
/draft participant add user [label] [seat]   /draft participant remove user|seat   /draft participant list
/draft config view | rounds | picks-per-round | participants | snake | skip-time | skip-hours |
             timezone | prepicks | trades | two-for-one | future-picks | trade-approval |
             after-skip | team-instances | seats-per-user | roster-size | pick-confirmation | admin-role
/draft randomize                        /draft start
/draft skip                             /draft complete
/draft roster add | replace | drop | move
/draft team add | remove | restore | list
/draft pick force | correct
/draft trade approve | deny | list
/draft reset [purge]                    /draft audit [limit]
```

Participant / everyone:

```
/status                                 /pick team
/prepicks add | remove | view | reorder | clear
/roster [user|seat]                     /team number
/trade propose with give receive        /trade accept | reject | cancel | list
```

## Implementation plan

1. Domain types, errors, pure snake-order generator, config defaults and validation.
2. Database connection, migrations, repositories.
3. Draft engine: setup, randomize, start, picks, skips, advancing, completion, admin corrections, reset.
4. Prepicks and their application inside the engine.
5. Trade engine on top of draft assets.
6. Active-hours deadline math and the durable timer service with recovery.
7. Draft service (locking, announcements, timer arming) and announcer.
8. Discord commands, components, views, permissions, registration script.
9. Tests (unit + integration, including concurrency and restart recovery).
10. Documentation and `.env.example`.
