import type { SqliteDatabase } from '../connection.js';
import type { Repick, RepickStatus } from '../../domain/types.js';
import { mapRepick, type Row } from './mappers.js';

export class RepickRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: { draftId: number; participantId: number; assetId: number; oldTeamId: number; pickSlotId: number | null; reason: string | null; openedBy: string; now: string }): Repick {
    const res = this.db
      .prepare(
        `INSERT INTO repicks (draft_id, participant_id, asset_id, old_team_id, pick_slot_id, status, reason, opened_by, opened_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(input.draftId, input.participantId, input.assetId, input.oldTeamId, input.pickSlotId, input.reason, input.openedBy, input.now);
    return this.getById(Number(res.lastInsertRowid)) as Repick;
  }

  getById(id: number): Repick | null {
    const row = this.db.prepare('SELECT * FROM repicks WHERE id = ?').get(id) as Row | undefined;
    return row ? mapRepick(row) : null;
  }

  listOpen(draftId: number): Repick[] {
    return (this.db.prepare(`SELECT * FROM repicks WHERE draft_id = ? AND status IN ('open','proposed') ORDER BY id`).all(draftId) as Row[]).map(mapRepick);
  }

  listOpenForParticipant(participantId: number): Repick[] {
    return (this.db.prepare(`SELECT * FROM repicks WHERE participant_id = ? AND status IN ('open','proposed') ORDER BY id`).all(participantId) as Row[]).map(mapRepick);
  }

  listByDraft(draftId: number, limit = 50): Repick[] {
    return (this.db.prepare('SELECT * FROM repicks WHERE draft_id = ? ORDER BY id DESC LIMIT ?').all(draftId, limit) as Row[]).map(mapRepick);
  }

  setProposal(id: number, teamId: number | null, proposedBy: string | null, now: string | null): void {
    this.db.prepare(`UPDATE repicks SET proposed_team_id = ?, proposed_by = ?, proposed_at = ?, status = ? WHERE id = ?`).run(teamId, proposedBy, now, teamId ? 'proposed' : 'open', id);
  }

  setStatus(id: number, status: RepickStatus, resolvedBy: string, now: string, note: string | null): void {
    this.db.prepare('UPDATE repicks SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?').run(status, resolvedBy, now, note, id);
  }

  setNote(id: number, note: string | null): void {
    this.db.prepare('UPDATE repicks SET resolution_note = ? WHERE id = ?').run(note, id);
  }
}
