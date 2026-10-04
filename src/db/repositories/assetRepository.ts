import type { SqliteDatabase } from '../connection.js';
import type { AcquiredVia, AssetStatus, AssetTransfer, DraftAsset } from '../../domain/types.js';
import { mapAsset, mapTransfer, type Row } from './mappers.js';

export interface TeamAssetWithSlot extends DraftAsset {
  overallPick: number | null;
  round: number | null;
}

export class AssetRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createPickAsset(input: { draftId: number; pickSlotId: number; participantId: number; now: string }): DraftAsset {
    const res = this.db
      .prepare(
        `INSERT INTO draft_assets (draft_id, asset_type, pick_slot_id, original_participant_id, current_participant_id, status, acquired_via, created_at, updated_at)
         VALUES (?, 'pick', ?, ?, ?, 'active', 'draft', ?, ?)`,
      )
      .run(input.draftId, input.pickSlotId, input.participantId, input.participantId, input.now, input.now);
    return this.getById(Number(res.lastInsertRowid)) as DraftAsset;
  }

  createTeamAsset(input: {
    draftId: number;
    teamId: number;
    instanceNo: number;
    pickSlotId: number | null;
    participantId: number;
    acquiredVia: AcquiredVia;
    now: string;
  }): DraftAsset {
    const res = this.db
      .prepare(
        `INSERT INTO draft_assets (draft_id, asset_type, team_id, pick_slot_id, instance_no, original_participant_id, current_participant_id, status, acquired_via, created_at, updated_at)
         VALUES (?, 'team', ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(input.draftId, input.teamId, input.pickSlotId, input.instanceNo, input.participantId, input.participantId, input.acquiredVia, input.now, input.now);
    return this.getById(Number(res.lastInsertRowid)) as DraftAsset;
  }

  getById(id: number): DraftAsset | null {
    const row = this.db.prepare('SELECT * FROM draft_assets WHERE id = ?').get(id) as Row | undefined;
    return row ? mapAsset(row) : null;
  }

  getPickAssetForSlot(slotId: number): DraftAsset | null {
    const row = this.db.prepare(`SELECT * FROM draft_assets WHERE pick_slot_id = ? AND asset_type = 'pick'`).get(slotId) as Row | undefined;
    return row ? mapAsset(row) : null;
  }

  getTeamAssetForSlot(slotId: number): DraftAsset | null {
    const row = this.db
      .prepare(`SELECT * FROM draft_assets WHERE pick_slot_id = ? AND asset_type = 'team' AND status = 'active'`)
      .get(slotId) as Row | undefined;
    return row ? mapAsset(row) : null;
  }

  /** Active team assets (the roster) for a participant, in pick order. */
  listRoster(participantId: number): TeamAssetWithSlot[] {
    return (
      this.db
        .prepare(
          `SELECT a.*, s.overall_pick, s.round FROM draft_assets a
           LEFT JOIN pick_slots s ON s.id = a.pick_slot_id
           WHERE a.current_participant_id = ? AND a.asset_type = 'team' AND a.status = 'active'
           ORDER BY s.overall_pick IS NULL, s.overall_pick, a.id`,
        )
        .all(participantId) as Row[]
    ).map((r) => ({ ...mapAsset(r), overallPick: r.overall_pick ?? null, round: r.round ?? null }));
  }

  /** Active pick assets owned by a participant whose slot is still pending (future picks). */
  listFuturePicks(participantId: number): Array<DraftAsset & { overallPick: number; round: number; slotStatus: string }> {
    return (
      this.db
        .prepare(
          `SELECT a.*, s.overall_pick, s.round, s.status AS slot_status FROM draft_assets a
           JOIN pick_slots s ON s.id = a.pick_slot_id
           WHERE a.current_participant_id = ? AND a.asset_type = 'pick' AND a.status = 'active'
           ORDER BY s.overall_pick`,
        )
        .all(participantId) as Row[]
    ).map((r) => ({ ...mapAsset(r), overallPick: r.overall_pick, round: r.round, slotStatus: r.slot_status }));
  }

  /** Active team assets for a team across all participants, with slot info. */
  listActiveForTeam(teamId: number): TeamAssetWithSlot[] {
    return (
      this.db
        .prepare(
          `SELECT a.*, s.overall_pick, s.round FROM draft_assets a
           LEFT JOIN pick_slots s ON s.id = a.pick_slot_id
           WHERE a.team_id = ? AND a.asset_type = 'team' AND a.status = 'active'
           ORDER BY a.instance_no`,
        )
        .all(teamId) as Row[]
    ).map((r) => ({ ...mapAsset(r), overallPick: r.overall_pick ?? null, round: r.round ?? null }));
  }

  findActiveTeamAsset(participantId: number, teamId: number): DraftAsset | null {
    const row = this.db
      .prepare(
        `SELECT * FROM draft_assets WHERE current_participant_id = ? AND team_id = ? AND asset_type = 'team' AND status = 'active' ORDER BY id LIMIT 1`,
      )
      .get(participantId, teamId) as Row | undefined;
    return row ? mapAsset(row) : null;
  }

  usedInstanceNumbers(teamId: number): number[] {
    return (
      this.db.prepare(`SELECT instance_no FROM draft_assets WHERE team_id = ? AND asset_type = 'team' AND status = 'active'`).all(teamId) as Array<{ instance_no: number }>
    ).map((r) => r.instance_no);
  }

  countActiveTeamAssets(participantId: number): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM draft_assets WHERE current_participant_id = ? AND asset_type = 'team' AND status = 'active'`).get(participantId) as { c: number }
    ).c;
  }

  countPendingPickAssets(participantId: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM draft_assets a JOIN pick_slots s ON s.id = a.pick_slot_id
           WHERE a.current_participant_id = ? AND a.asset_type = 'pick' AND a.status = 'active' AND s.status IN ('pending','current','skipped')`,
        )
        .get(participantId) as { c: number }
    ).c;
  }

  setStatus(assetId: number, status: AssetStatus, now: string): void {
    this.db.prepare('UPDATE draft_assets SET status = ?, updated_at = ? WHERE id = ?').run(status, now, assetId);
  }

  setTeam(assetId: number, teamId: number, instanceNo: number, now: string): void {
    this.db.prepare('UPDATE draft_assets SET team_id = ?, instance_no = ?, updated_at = ? WHERE id = ?').run(teamId, instanceNo, now, assetId);
  }

  setOwner(assetId: number, participantId: number, acquiredVia: AcquiredVia, now: string): void {
    this.db.prepare('UPDATE draft_assets SET current_participant_id = ?, acquired_via = ?, updated_at = ? WHERE id = ?').run(participantId, acquiredVia, now, assetId);
  }

  recordTransfer(input: {
    draftId: number;
    assetId: number;
    from: number;
    to: number;
    reason: 'trade' | 'admin_move';
    tradeId: number | null;
    actor: string | null;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO asset_transfers (draft_id, asset_id, from_participant_id, to_participant_id, reason, trade_id, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.draftId, input.assetId, input.from, input.to, input.reason, input.tradeId, input.actor, input.now);
  }

  listTransfers(assetId: number): AssetTransfer[] {
    return (this.db.prepare('SELECT * FROM asset_transfers WHERE asset_id = ? ORDER BY id').all(assetId) as Row[]).map(mapTransfer);
  }

  listTransfersForDraft(draftId: number): AssetTransfer[] {
    return (this.db.prepare('SELECT * FROM asset_transfers WHERE draft_id = ? ORDER BY id').all(draftId) as Row[]).map(mapTransfer);
  }

  listByDraft(draftId: number): DraftAsset[] {
    return (this.db.prepare('SELECT * FROM draft_assets WHERE draft_id = ? ORDER BY id').all(draftId) as Row[]).map(mapAsset);
  }
}
