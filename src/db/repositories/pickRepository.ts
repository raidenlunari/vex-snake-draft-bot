import type { SqliteDatabase } from '../connection.js';
import type { DraftPick, PickKind } from '../../domain/types.js';
import { mapPick, type Row } from './mappers.js';

export class PickRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: {
    draftId: number;
    pickSlotId: number | null;
    overallPick: number | null;
    round: number | null;
    participantId: number;
    teamId: number;
    assetId: number | null;
    kind: PickKind;
    madeBy: string | null;
    now: string;
  }): DraftPick {
    const res = this.db
      .prepare(
        `INSERT INTO draft_picks (draft_id, pick_slot_id, overall_pick, round, participant_id, team_id, asset_id, kind, made_by, made_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.draftId, input.pickSlotId, input.overallPick, input.round, input.participantId, input.teamId, input.assetId, input.kind, input.madeBy, input.now);
    return this.getById(Number(res.lastInsertRowid)) as DraftPick;
  }

  getById(id: number): DraftPick | null {
    const row = this.db.prepare('SELECT * FROM draft_picks WHERE id = ?').get(id) as Row | undefined;
    return row ? mapPick(row) : null;
  }

  getActiveForAsset(assetId: number): DraftPick | null {
    const row = this.db.prepare('SELECT * FROM draft_picks WHERE asset_id = ? AND voided_at IS NULL ORDER BY id DESC LIMIT 1').get(assetId) as Row | undefined;
    return row ? mapPick(row) : null;
  }

  listByDraft(draftId: number, opts: { includeVoided?: boolean } = {}): DraftPick[] {
    const sql = opts.includeVoided
      ? 'SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY id'
      : 'SELECT * FROM draft_picks WHERE draft_id = ? AND voided_at IS NULL ORDER BY overall_pick IS NULL, overall_pick, id';
    return (this.db.prepare(sql).all(draftId) as Row[]).map(mapPick);
  }

  listRecent(draftId: number, limit: number): DraftPick[] {
    return (
      this.db
        .prepare('SELECT * FROM draft_picks WHERE draft_id = ? AND voided_at IS NULL AND overall_pick IS NOT NULL ORDER BY overall_pick DESC LIMIT ?')
        .all(draftId, limit) as Row[]
    ).map(mapPick);
  }

  void(pickId: number, voidedBy: string, reason: string, now: string): void {
    this.db.prepare('UPDATE draft_picks SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(now, voidedBy, reason, pickId);
  }
}
