import type { SqliteDatabase } from '../connection.js';
import type { Team } from '../../domain/types.js';
import { mapTeam, type Row } from './mappers.js';

export interface TeamInput {
  teamNumber: string;
  teamName: string | null;
  organization: string | null;
  location: string | null;
  extra: Record<string, string> | null;
}

export class TeamRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(draftId: number, input: TeamInput, now: string): Team {
    const res = this.db
      .prepare(
        `INSERT INTO teams (draft_id, team_number, team_name, organization, location, extra_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(draftId, input.teamNumber, input.teamName, input.organization, input.location, input.extra ? JSON.stringify(input.extra) : null, now, now);
    return this.getById(Number(res.lastInsertRowid)) as Team;
  }

  update(teamId: number, input: Partial<TeamInput>, now: string): void {
    const current = this.getById(teamId);
    if (!current) return;
    this.db
      .prepare('UPDATE teams SET team_name = ?, organization = ?, location = ?, extra_json = ?, updated_at = ? WHERE id = ?')
      .run(
        input.teamName !== undefined ? input.teamName : current.teamName,
        input.organization !== undefined ? input.organization : current.organization,
        input.location !== undefined ? input.location : current.location,
        input.extra !== undefined ? (input.extra ? JSON.stringify(input.extra) : null) : current.extra ? JSON.stringify(current.extra) : null,
        now,
        teamId,
      );
  }

  getById(id: number): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTeam(row) : null;
  }

  getByNumber(draftId: number, teamNumber: string): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE draft_id = ? AND team_number = ?').get(draftId, teamNumber) as Row | undefined;
    return row ? mapTeam(row) : null;
  }

  listByDraft(draftId: number, opts: { includeRemoved?: boolean } = {}): Team[] {
    const sql = opts.includeRemoved
      ? 'SELECT * FROM teams WHERE draft_id = ? ORDER BY team_number'
      : 'SELECT * FROM teams WHERE draft_id = ? AND removed_at IS NULL ORDER BY team_number';
    return (this.db.prepare(sql).all(draftId) as Row[]).map(mapTeam);
  }

  /** Teams that still have at least one draftable instance. */
  listAvailable(draftId: number, maxInstances: number, search?: string, limit = 25): Team[] {
    const like = search ? `%${search.toUpperCase()}%` : '%';
    return (
      this.db
        .prepare(
          `SELECT t.* FROM teams t
           WHERE t.draft_id = ? AND t.removed_at IS NULL
             AND (SELECT COUNT(*) FROM draft_assets a WHERE a.team_id = t.id AND a.asset_type = 'team' AND a.status = 'active') < ?
             AND (UPPER(t.team_number) LIKE ? OR UPPER(COALESCE(t.team_name, '')) LIKE ?)
           ORDER BY t.team_number LIMIT ?`,
        )
        .all(draftId, maxInstances, like, like, limit) as Row[]
    ).map(mapTeam);
  }

  countAvailable(draftId: number, maxInstances: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM teams t
         WHERE t.draft_id = ? AND t.removed_at IS NULL
           AND (SELECT COUNT(*) FROM draft_assets a WHERE a.team_id = t.id AND a.asset_type = 'team' AND a.status = 'active') < ?`,
      )
      .get(draftId, maxInstances) as { c: number };
    return row.c;
  }

  countActiveInstances(teamId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM draft_assets WHERE team_id = ? AND asset_type = 'team' AND status = 'active'`)
      .get(teamId) as { c: number };
    return row.c;
  }

  search(draftId: number, query: string, limit = 25): Team[] {
    const like = `%${query.toUpperCase()}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM teams WHERE draft_id = ? AND removed_at IS NULL AND (UPPER(team_number) LIKE ? OR UPPER(COALESCE(team_name,'')) LIKE ?)
           ORDER BY team_number LIMIT ?`,
        )
        .all(draftId, like, like, limit) as Row[]
    ).map(mapTeam);
  }

  setRemoved(teamId: number, removedAt: string | null, now: string): void {
    this.db.prepare('UPDATE teams SET removed_at = ?, updated_at = ? WHERE id = ?').run(removedAt, now, teamId);
  }

  count(draftId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM teams WHERE draft_id = ? AND removed_at IS NULL').get(draftId) as { c: number }).c;
  }
}
