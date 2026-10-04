import type { SqliteDatabase } from '../connection.js';
import type { ChannelKind, Draft, DraftConfig, DraftStatus, GuildSettings } from '../../domain/types.js';
import { configToRow, mapConfig, mapDraft, mapGuildSettings, type Row } from './mappers.js';

export interface DraftTurnState {
  currentSlotId: number | null;
  turnToken: string | null;
  turnStartedAt: string | null;
  turnDeadlineAt: string | null;
}

export class DraftRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: { guildId: string; name: string; createdBy: string; now: string; config: DraftConfig }): Draft {
    const result = this.db
      .prepare(
        `INSERT INTO drafts (guild_id, name, status, created_by, created_at, version)
         VALUES (?, ?, 'setup', ?, ?, 0)`,
      )
      .run(input.guildId, input.name, input.createdBy, input.now);
    const id = Number(result.lastInsertRowid);
    const row = configToRow(input.config);
    const cols = Object.keys(row);
    this.db
      .prepare(
        `INSERT INTO draft_configs (draft_id, ${cols.join(', ')}, updated_at)
         VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      )
      .run(id, ...cols.map((c) => row[c]), input.now);
    return this.getById(id) as Draft;
  }

  getById(id: number): Draft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
    return row ? mapDraft(row) : null;
  }

  /** The single open draft (setup / randomized / active) for the guild. */
  getOpenForGuild(guildId: string): Draft | null {
    const row = this.db
      .prepare(`SELECT * FROM drafts WHERE guild_id = ? AND status IN ('setup','randomized','active') ORDER BY id DESC LIMIT 1`)
      .get(guildId) as Row | undefined;
    return row ? mapDraft(row) : null;
  }

  /** Latest non-archived draft (open or completed) for the guild. */
  getCurrentForGuild(guildId: string): Draft | null {
    const row = this.db
      .prepare(`SELECT * FROM drafts WHERE guild_id = ? AND status != 'archived' ORDER BY id DESC LIMIT 1`)
      .get(guildId) as Row | undefined;
    return row ? mapDraft(row) : null;
  }

  listByStatus(status: DraftStatus): Draft[] {
    return (this.db.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY id').all(status) as Row[]).map(mapDraft);
  }

  listForGuild(guildId: string, limit = 20): Draft[] {
    return (this.db.prepare('SELECT * FROM drafts WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guildId, limit) as Row[]).map(mapDraft);
  }

  getConfig(draftId: number): DraftConfig {
    const row = this.db.prepare('SELECT * FROM draft_configs WHERE draft_id = ?').get(draftId) as Row | undefined;
    if (!row) throw new Error(`Draft ${draftId} has no configuration row`);
    return mapConfig(row);
  }

  saveConfig(draftId: number, config: DraftConfig, now: string): void {
    const row = configToRow(config);
    const cols = Object.keys(row);
    this.db
      .prepare(`UPDATE draft_configs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE draft_id = ?`)
      .run(...cols.map((c) => row[c]), now, draftId);
  }

  setStatus(draftId: number, status: DraftStatus, now: string): void {
    const stampCol =
      status === 'randomized' ? 'randomized_at' : status === 'active' ? 'started_at' : status === 'completed' ? 'completed_at' : status === 'archived' ? 'archived_at' : null;
    if (stampCol) {
      this.db.prepare(`UPDATE drafts SET status = ?, ${stampCol} = ?, version = version + 1 WHERE id = ?`).run(status, now, draftId);
    } else {
      this.db.prepare('UPDATE drafts SET status = ?, version = version + 1 WHERE id = ?').run(status, draftId);
    }
  }

  setName(draftId: number, name: string): void {
    this.db.prepare('UPDATE drafts SET name = ?, version = version + 1 WHERE id = ?').run(name, draftId);
  }

  setChannel(draftId: number, channelId: string | null, kind: ChannelKind | null, parentChannelId: string | null): void {
    this.db
      .prepare('UPDATE drafts SET channel_id = ?, channel_kind = ?, parent_channel_id = ?, version = version + 1 WHERE id = ?')
      .run(channelId, kind, parentChannelId, draftId);
  }

  setTurn(draftId: number, turn: DraftTurnState): void {
    this.db
      .prepare(
        `UPDATE drafts SET current_slot_id = ?, turn_token = ?, turn_started_at = ?, turn_deadline_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(turn.currentSlotId, turn.turnToken, turn.turnStartedAt, turn.turnDeadlineAt, draftId);
  }

  bumpVersion(draftId: number): void {
    this.db.prepare('UPDATE drafts SET version = version + 1 WHERE id = ?').run(draftId);
  }

  delete(draftId: number): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(draftId);
  }

  getGuildSettings(guildId: string): GuildSettings | null {
    const row = this.db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Row | undefined;
    return row ? mapGuildSettings(row) : null;
  }

  setAdminRole(guildId: string, roleId: string | null, now: string): void {
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, admin_role_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET admin_role_id = excluded.admin_role_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, roleId, now);
  }
}
