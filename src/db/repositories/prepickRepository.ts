import type { SqliteDatabase } from '../connection.js';
import type { Prepick } from '../../domain/types.js';
import { mapPrepick, type Row } from './mappers.js';

export class PrepickRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(participantId: number): Prepick[] {
    return (this.db.prepare('SELECT * FROM prepicks WHERE participant_id = ? ORDER BY priority, id').all(participantId) as Row[]).map(mapPrepick);
  }

  find(participantId: number, teamId: number): Prepick | null {
    const row = this.db.prepare('SELECT * FROM prepicks WHERE participant_id = ? AND team_id = ?').get(participantId, teamId) as Row | undefined;
    return row ? mapPrepick(row) : null;
  }

  add(input: { draftId: number; participantId: number; teamId: number; priority: number; createdBy: string; now: string }): Prepick {
    const res = this.db
      .prepare('INSERT INTO prepicks (draft_id, participant_id, team_id, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.draftId, input.participantId, input.teamId, input.priority, input.createdBy, input.now);
    return this.db.prepare('SELECT * FROM prepicks WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as Prepick;
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM prepicks WHERE id = ?').run(id);
  }

  removeByTeam(draftId: number, teamId: number): number {
    return this.db.prepare('DELETE FROM prepicks WHERE draft_id = ? AND team_id = ?').run(draftId, teamId).changes;
  }

  clear(participantId: number): number {
    return this.db.prepare('DELETE FROM prepicks WHERE participant_id = ?').run(participantId).changes;
  }

  setPriority(id: number, priority: number): void {
    this.db.prepare('UPDATE prepicks SET priority = ? WHERE id = ?').run(priority, id);
  }

  /** Renumbers priorities to 1..n in the given id order. */
  reorder(participantId: number, orderedIds: number[]): void {
    // Two passes to avoid transient collisions if a unique index on priority is ever added.
    const stmt = this.db.prepare('UPDATE prepicks SET priority = ? WHERE id = ? AND participant_id = ?');
    orderedIds.forEach((id, i) => stmt.run(-(i + 1), id, participantId));
    orderedIds.forEach((id, i) => stmt.run(i + 1, id, participantId));
  }
}
