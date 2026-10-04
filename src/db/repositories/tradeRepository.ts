import type { SqliteDatabase } from '../connection.js';
import type { Trade, TradeAsset, TradeStatus } from '../../domain/types.js';
import { mapTrade, mapTradeAsset, type Row } from './mappers.js';

export class TradeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: {
    draftId: number;
    proposerParticipantId: number;
    counterpartyParticipantId: number;
    status: TradeStatus;
    proposedBy: string;
    note: string | null;
    now: string;
  }): Trade {
    const res = this.db
      .prepare(
        `INSERT INTO trades (draft_id, proposer_participant_id, counterparty_participant_id, status, proposed_by, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.draftId, input.proposerParticipantId, input.counterpartyParticipantId, input.status, input.proposedBy, input.note, input.now);
    return this.getById(Number(res.lastInsertRowid)) as Trade;
  }

  addAsset(input: { tradeId: number; assetId: number; from: number; to: number }): void {
    this.db
      .prepare('INSERT INTO trade_assets (trade_id, asset_id, from_participant_id, to_participant_id) VALUES (?, ?, ?, ?)')
      .run(input.tradeId, input.assetId, input.from, input.to);
  }

  getById(id: number): Trade | null {
    const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTrade(row) : null;
  }

  listAssets(tradeId: number): TradeAsset[] {
    return (this.db.prepare('SELECT * FROM trade_assets WHERE trade_id = ? ORDER BY rowid').all(tradeId) as Row[]).map(mapTradeAsset);
  }

  listOpen(draftId: number): Trade[] {
    return (this.db.prepare(`SELECT * FROM trades WHERE draft_id = ? AND status IN ('proposed','accepted') ORDER BY id`).all(draftId) as Row[]).map(mapTrade);
  }

  listByDraft(draftId: number, limit = 50): Trade[] {
    return (this.db.prepare('SELECT * FROM trades WHERE draft_id = ? ORDER BY id DESC LIMIT ?').all(draftId, limit) as Row[]).map(mapTrade);
  }

  /** Open trades that reference any of the given assets. */
  openTradesForAssets(draftId: number, assetIds: number[]): Trade[] {
    if (assetIds.length === 0) return [];
    const placeholders = assetIds.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT DISTINCT t.* FROM trades t JOIN trade_assets ta ON ta.trade_id = t.id
           WHERE t.draft_id = ? AND t.status IN ('proposed','accepted') AND ta.asset_id IN (${placeholders}) ORDER BY t.id`,
        )
        .all(draftId, ...assetIds) as Row[]
    ).map(mapTrade);
  }

  setStatus(tradeId: number, status: TradeStatus, fields: { respondedAt?: string; respondedBy?: string; resolvedAt?: string; resolvedBy?: string; resolutionNote?: string | null }): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    if (fields.respondedAt !== undefined) { sets.push('responded_at = ?'); vals.push(fields.respondedAt); }
    if (fields.respondedBy !== undefined) { sets.push('responded_by = ?'); vals.push(fields.respondedBy); }
    if (fields.resolvedAt !== undefined) { sets.push('resolved_at = ?'); vals.push(fields.resolvedAt); }
    if (fields.resolvedBy !== undefined) { sets.push('resolved_by = ?'); vals.push(fields.resolvedBy); }
    if (fields.resolutionNote !== undefined) { sets.push('resolution_note = ?'); vals.push(fields.resolutionNote); }
    vals.push(tradeId);
    this.db.prepare(`UPDATE trades SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  setMessage(tradeId: number, channelId: string, messageId: string): void {
    this.db.prepare('UPDATE trades SET message_channel_id = ?, message_id = ? WHERE id = ?').run(channelId, messageId, tradeId);
  }

  /** Trades (executed) that moved the given asset. */
  listExecutedForAsset(assetId: number): Trade[] {
    return (
      this.db
        .prepare(`SELECT t.* FROM trades t JOIN trade_assets ta ON ta.trade_id = t.id WHERE ta.asset_id = ? AND t.status = 'executed' ORDER BY t.id`)
        .all(assetId) as Row[]
    ).map(mapTrade);
  }
}
