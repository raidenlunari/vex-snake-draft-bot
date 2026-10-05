import type { Database } from 'better-sqlite3';

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  admin_role_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('setup','randomized','active','completed','archived')),
  channel_id TEXT,
  channel_kind TEXT,
  parent_channel_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  randomized_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  archived_at TEXT,
  current_slot_id INTEGER,
  turn_token TEXT,
  turn_started_at TEXT,
  turn_deadline_at TEXT,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX drafts_one_open_per_guild
  ON drafts(guild_id) WHERE status IN ('setup','randomized','active');
CREATE INDEX drafts_status ON drafts(status);

CREATE TABLE draft_configs (
  draft_id INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  participant_count INTEGER,
  rounds INTEGER NOT NULL,
  picks_per_round INTEGER NOT NULL,
  snake_order INTEGER NOT NULL,
  skip_timer_seconds INTEGER,
  skip_hours_start TEXT,
  skip_hours_end TEXT,
  timezone TEXT NOT NULL,
  allow_prepicks INTEGER NOT NULL,
  prepick_mode TEXT NOT NULL,
  allow_trades INTEGER NOT NULL,
  allow_two_for_one INTEGER NOT NULL,
  allow_future_pick_trades INTEGER NOT NULL,
  trade_approval TEXT NOT NULL,
  allow_trades_after_completion INTEGER NOT NULL,
  after_skip_policy TEXT NOT NULL,
  max_instances_per_team INTEGER NOT NULL,
  max_seats_per_user INTEGER NOT NULL,
  max_roster_size INTEGER,
  require_pick_confirmation INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  draft_position INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE UNIQUE INDEX participants_position
  ON participants(draft_id, draft_position) WHERE draft_position IS NOT NULL;
CREATE UNIQUE INDEX participants_label ON participants(draft_id, label COLLATE NOCASE);

CREATE TABLE participant_users (
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  added_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, discord_user_id)
);
CREATE INDEX participant_users_user ON participant_users(draft_id, discord_user_id);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  team_number TEXT NOT NULL,
  team_name TEXT,
  organization TEXT,
  location TEXT,
  extra_json TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (draft_id, team_number)
);

CREATE TABLE pick_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall_pick INTEGER NOT NULL,
  round INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  turn_in_round INTEGER NOT NULL,
  pick_in_turn INTEGER NOT NULL,
  original_participant_id INTEGER NOT NULL REFERENCES participants(id),
  status TEXT NOT NULL CHECK (status IN ('pending','current','picked','skipped','forfeited','void')),
  skipped_at TEXT,
  UNIQUE (draft_id, overall_pick)
);
CREATE INDEX pick_slots_status ON pick_slots(draft_id, status, overall_pick);

CREATE TABLE draft_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('team','pick')),
  team_id INTEGER REFERENCES teams(id),
  pick_slot_id INTEGER REFERENCES pick_slots(id),
  instance_no INTEGER,
  original_participant_id INTEGER NOT NULL REFERENCES participants(id),
  current_participant_id INTEGER NOT NULL REFERENCES participants(id),
  status TEXT NOT NULL CHECK (status IN ('active','consumed','dropped','removed','void')),
  acquired_via TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX draft_assets_pick_slot
  ON draft_assets(pick_slot_id) WHERE asset_type = 'pick';
CREATE UNIQUE INDEX draft_assets_team_instance
  ON draft_assets(draft_id, team_id, instance_no) WHERE asset_type = 'team' AND status = 'active';
CREATE INDEX draft_assets_owner ON draft_assets(draft_id, current_participant_id, status);
CREATE INDEX draft_assets_team ON draft_assets(draft_id, team_id, status);

CREATE TABLE draft_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  pick_slot_id INTEGER REFERENCES pick_slots(id),
  overall_pick INTEGER,
  round INTEGER,
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  asset_id INTEGER REFERENCES draft_assets(id),
  kind TEXT NOT NULL,
  made_by TEXT,
  made_at TEXT NOT NULL,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);
CREATE INDEX draft_picks_draft ON draft_picks(draft_id, overall_pick);

CREATE TABLE prepicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (participant_id, team_id)
);
CREATE INDEX prepicks_participant ON prepicks(participant_id, priority);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  proposer_participant_id INTEGER NOT NULL REFERENCES participants(id),
  counterparty_participant_id INTEGER NOT NULL REFERENCES participants(id),
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','executed','rejected','cancelled','denied','failed')),
  proposed_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  responded_by TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  message_channel_id TEXT,
  message_id TEXT
);
CREATE INDEX trades_draft_status ON trades(draft_id, status);

CREATE TABLE trade_assets (
  trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES draft_assets(id),
  from_participant_id INTEGER NOT NULL REFERENCES participants(id),
  to_participant_id INTEGER NOT NULL REFERENCES participants(id),
  PRIMARY KEY (trade_id, asset_id)
);
CREATE INDEX trade_assets_asset ON trade_assets(asset_id);

CREATE TABLE asset_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES draft_assets(id) ON DELETE CASCADE,
  from_participant_id INTEGER NOT NULL,
  to_participant_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX asset_transfers_asset ON asset_transfers(asset_id, id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  draft_id INTEGER,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  actor_kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  subject_json TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_events_draft ON audit_events(draft_id, id);
CREATE INDEX audit_events_guild ON audit_events(guild_id, id);
`,
  },
  {
    id: 2,
    name: 'google sheet sync settings',
    sql: `
ALTER TABLE drafts ADD COLUMN sheet_spreadsheet_id TEXT;
ALTER TABLE drafts ADD COLUMN sheet_tab TEXT;
`,
  },
  {
    id: 3,
    name: 'repicks',
    sql: `
CREATE TABLE repicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES draft_assets(id) ON DELETE CASCADE,
  old_team_id INTEGER NOT NULL REFERENCES teams(id),
  pick_slot_id INTEGER REFERENCES pick_slots(id),
  status TEXT NOT NULL CHECK (status IN ('open','proposed','approved','cancelled')),
  proposed_team_id INTEGER REFERENCES teams(id),
  reason TEXT,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  proposed_by TEXT,
  proposed_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE INDEX repicks_draft_status ON repicks(draft_id, status);
`,
  },
];

export function runMigrations(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => r.id),
  );
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    })();
    count += 1;
  }
  return count;
}

export const LATEST_MIGRATION_ID = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;
