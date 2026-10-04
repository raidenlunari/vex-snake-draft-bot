import type { SqliteDatabase } from '../connection.js';
import type { PickSlot, SlotStatus } from '../../domain/types.js';
import type { PickSlotSpec } from '../../domain/snakeOrder.js';
import { mapSlot, type Row } from './mappers.js';

export class SlotRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createMany(draftId: number, specs: PickSlotSpec[], seatIdByIndex: number[]): PickSlot[] {
    const stmt = this.db.prepare(
      `INSERT INTO pick_slots (draft_id, overall_pick, round, pick_in_round, turn_in_round, pick_in_turn, original_participant_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const s of specs) {
      const pid = seatIdByIndex[s.seatIndex];
      if (pid === undefined) throw new Error(`No participant for seat index ${s.seatIndex}`);
      stmt.run(draftId, s.overall, s.round, s.pickInRound, s.turnInRound, s.pickInTurn, pid);
    }
    return this.listByDraft(draftId);
  }

  getById(id: number): PickSlot | null {
    const row = this.db.prepare('SELECT * FROM pick_slots WHERE id = ?').get(id) as Row | undefined;
    return row ? mapSlot(row) : null;
  }

  getByOverall(draftId: number, overall: number): PickSlot | null {
    const row = this.db.prepare('SELECT * FROM pick_slots WHERE draft_id = ? AND overall_pick = ?').get(draftId, overall) as Row | undefined;
    return row ? mapSlot(row) : null;
  }

  listByDraft(draftId: number): PickSlot[] {
    return (this.db.prepare('SELECT * FROM pick_slots WHERE draft_id = ? ORDER BY overall_pick').all(draftId) as Row[]).map(mapSlot);
  }

  nextPending(draftId: number, afterOverall: number): PickSlot | null {
    const row = this.db
      .prepare(`SELECT * FROM pick_slots WHERE draft_id = ? AND status = 'pending' AND overall_pick > ? ORDER BY overall_pick LIMIT 1`)
      .get(draftId, afterOverall) as Row | undefined;
    return row ? mapSlot(row) : null;
  }

  listByStatus(draftId: number, status: SlotStatus): PickSlot[] {
    return (this.db.prepare('SELECT * FROM pick_slots WHERE draft_id = ? AND status = ? ORDER BY overall_pick').all(draftId, status) as Row[]).map(mapSlot);
  }

  setStatus(slotId: number, status: SlotStatus, skippedAt?: string | null): void {
    if (skippedAt !== undefined) {
      this.db.prepare('UPDATE pick_slots SET status = ?, skipped_at = ? WHERE id = ?').run(status, skippedAt, slotId);
    } else {
      this.db.prepare('UPDATE pick_slots SET status = ? WHERE id = ?').run(status, slotId);
    }
  }

  countByStatus(draftId: number): Record<SlotStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM pick_slots WHERE draft_id = ? GROUP BY status').all(draftId) as Array<{ status: SlotStatus; c: number }>;
    const out: Record<SlotStatus, number> = { pending: 0, current: 0, picked: 0, skipped: 0, forfeited: 0, void: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  count(draftId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM pick_slots WHERE draft_id = ?').get(draftId) as { c: number }).c;
  }

  deleteByDraft(draftId: number): void {
    this.db.prepare('DELETE FROM pick_slots WHERE draft_id = ?').run(draftId);
  }
}
