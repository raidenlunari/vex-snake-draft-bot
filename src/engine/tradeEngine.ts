import { inTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import { DraftError } from '../domain/errors.js';
import type { Actor, DraftAsset, ParticipantWithUsers, Team, Trade, TradeAsset } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import { loadContext, type DraftContext } from './context.js';
import type { DraftEvent } from './events.js';

export interface AssetDescription {
  asset: DraftAsset;
  label: string;
}

export interface TradeView {
  trade: Trade;
  proposer: ParticipantWithUsers;
  counterparty: ParticipantWithUsers;
  gives: AssetDescription[];
  receives: AssetDescription[];
}

export interface ProposeTradeInput {
  proposerParticipantId: number;
  counterpartyParticipantId: number;
  giveAssetIds: number[];
  receiveAssetIds: number[];
  actor: Actor;
  note?: string | null;
}

export const MAX_ASSETS_PER_SIDE = 3;

export interface TradeResolution {
  view: TradeView;
  events: DraftEvent[];
  executed: boolean;
  awaitingAdmin: boolean;
  /** Set when execution was attempted and failed validation; the trade is then `failed`. */
  failure: string | null;
}

/**
 * Trades move ownership of draft assets (team instances and future picks) between
 * participants. Validation runs at proposal time and again, inside the same
 * transaction, at execution time so stale trades can never corrupt rosters.
 */
export class TradeEngine {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  propose(draftId: number, input: ProposeTradeInput): { view: TradeView; events: DraftEvent[]; failure: string | null } {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      this.assertTradingOpen(ctx);
      const proposer = this.requireParticipant(ctx, input.proposerParticipantId);
      const counterparty = this.requireParticipant(ctx, input.counterpartyParticipantId);
      if (input.actor.kind === 'user' && !this.repos.participants.isMember(proposer.id, input.actor.id)) {
        throw new DraftError('PERMISSION_DENIED', `You are not a member of "${proposer.label}" and cannot trade on its behalf.`);
      }
      if (proposer.id === counterparty.id) throw new DraftError('TRADE_ERROR', 'You cannot trade with yourself.');
      const gives = this.loadAssets(ctx, input.giveAssetIds);
      const receives = this.loadAssets(ctx, input.receiveAssetIds);
      this.validate(ctx, proposer, counterparty, gives, receives);
      const now = this.clock.nowIso();
      const autoExecute = ctx.config.tradeApproval === 'auto';
      const trade = this.repos.trades.create({
        draftId,
        proposerParticipantId: proposer.id,
        counterpartyParticipantId: counterparty.id,
        status: 'proposed',
        proposedBy: input.actor.id,
        note: input.note ?? null,
        now,
      });
      for (const a of gives) this.repos.trades.addAsset({ tradeId: trade.id, assetId: a.id, from: proposer.id, to: counterparty.id });
      for (const a of receives) this.repos.trades.addAsset({ tradeId: trade.id, assetId: a.id, from: counterparty.id, to: proposer.id });
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'trade_proposed',
        actor: input.actor,
        summary: `Trade #${trade.id} proposed: "${proposer.label}" gives ${this.describeMany(gives)} for ${this.describeMany(receives)} from "${counterparty.label}"`,
        subject: { tradeId: trade.id, give: gives.map((a) => a.id), receive: receives.map((a) => a.id) },
        now,
      });
      const events: DraftEvent[] = [];
      let failure: string | null = null;
      if (autoExecute) {
        failure = this.execute(ctx, this.repos.trades.getById(trade.id) as Trade, input.actor, events);
      }
      return { view: this.view(draftId, trade.id), events, failure };
    });
  }

  /**
   * Counterparty accepts or rejects. Only a member of the counterparty seat may answer;
   * an admin may answer on behalf of a seat that has no Discord users at all.
   */
  respond(draftId: number, tradeId: number, accept: boolean, actor: Actor): TradeResolution {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const trade = this.requireTrade(ctx, tradeId);
      if (trade.status !== 'proposed') throw new DraftError('TRADE_ERROR', `Trade #${tradeId} is ${trade.status} and can no longer be answered.`);
      const counterparty = this.requireParticipant(ctx, trade.counterpartyParticipantId);
      const isMember = this.repos.participants.isMember(counterparty.id, actor.id);
      const adminForUnmannedSeat = actor.kind === 'admin' && counterparty.users.length === 0;
      if (actor.kind !== 'system' && !isMember && !adminForUnmannedSeat) {
        throw new DraftError('PERMISSION_DENIED', `Only "${counterparty.label}" can answer this trade.`);
      }
      const now = this.clock.nowIso();
      const events: DraftEvent[] = [];
      if (!accept) {
        this.repos.trades.setStatus(tradeId, 'rejected', { respondedAt: now, respondedBy: actor.id, resolvedAt: now, resolvedBy: actor.id });
        this.repos.audit.record({ guildId: ctx.draft.guildId, draftId, eventType: 'trade_rejected', actor, summary: `Trade #${tradeId} rejected by "${counterparty.label}"`, subject: { tradeId }, now });
        return { view: this.view(draftId, tradeId), events, executed: false, awaitingAdmin: false, failure: null };
      }
      this.assertTradingOpen(ctx);
      this.repos.trades.setStatus(tradeId, 'accepted', { respondedAt: now, respondedBy: actor.id });
      this.repos.audit.record({ guildId: ctx.draft.guildId, draftId, eventType: 'trade_accepted', actor, summary: `Trade #${tradeId} accepted by "${counterparty.label}"`, subject: { tradeId }, now });
      if (ctx.config.tradeApproval === 'admin') {
        return { view: this.view(draftId, tradeId), events, executed: false, awaitingAdmin: true, failure: null };
      }
      const failure = this.execute(ctx, this.repos.trades.getById(tradeId) as Trade, actor, events);
      return { view: this.view(draftId, tradeId), events, executed: failure === null, awaitingAdmin: false, failure };
    });
  }

  /** Admin approves (executes) or denies an accepted trade. */
  adminResolve(draftId: number, tradeId: number, approve: boolean, actor: Actor): TradeResolution {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const trade = this.requireTrade(ctx, tradeId);
      if (trade.status !== 'accepted' && trade.status !== 'proposed') {
        throw new DraftError('TRADE_ERROR', `Trade #${tradeId} is ${trade.status} and cannot be resolved.`);
      }
      const now = this.clock.nowIso();
      const events: DraftEvent[] = [];
      if (!approve) {
        this.repos.trades.setStatus(tradeId, 'denied', { resolvedAt: now, resolvedBy: actor.id });
        this.repos.audit.record({ guildId: ctx.draft.guildId, draftId, eventType: 'trade_denied', actor, summary: `Trade #${tradeId} denied by an admin`, subject: { tradeId }, now });
        return { view: this.view(draftId, tradeId), events, executed: false, awaitingAdmin: false, failure: null };
      }
      if (trade.status !== 'accepted') throw new DraftError('TRADE_ERROR', `Trade #${tradeId} has not been accepted by the other side yet.`);
      this.assertTradingOpen(ctx);
      const failure = this.execute(ctx, trade, actor, events);
      return { view: this.view(draftId, tradeId), events, executed: failure === null, awaitingAdmin: false, failure };
    });
  }

  cancel(draftId: number, tradeId: number, actor: Actor): TradeView {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const trade = this.requireTrade(ctx, tradeId);
      if (trade.status !== 'proposed' && trade.status !== 'accepted') throw new DraftError('TRADE_ERROR', `Trade #${tradeId} is already ${trade.status}.`);
      const proposer = this.requireParticipant(ctx, trade.proposerParticipantId);
      const counterparty = this.requireParticipant(ctx, trade.counterpartyParticipantId);
      if (actor.kind === 'user') {
        const member = this.repos.participants.isMember(proposer.id, actor.id) || this.repos.participants.isMember(counterparty.id, actor.id);
        if (!member) throw new DraftError('PERMISSION_DENIED', 'Only the two parties (or an admin) can cancel this trade.');
      }
      const now = this.clock.nowIso();
      this.repos.trades.setStatus(tradeId, 'cancelled', { resolvedAt: now, resolvedBy: actor.id });
      this.repos.audit.record({ guildId: ctx.draft.guildId, draftId, eventType: 'trade_cancelled', actor, summary: `Trade #${tradeId} cancelled`, subject: { tradeId }, now });
      return this.view(draftId, tradeId);
    });
  }

  view(draftId: number, tradeId: number): TradeView {
    const ctx = loadContext(this.repos, draftId);
    const trade = this.requireTrade(ctx, tradeId);
    const proposer = this.requireParticipant(ctx, trade.proposerParticipantId);
    const counterparty = this.requireParticipant(ctx, trade.counterpartyParticipantId);
    const assets = this.repos.trades.listAssets(tradeId);
    const describe = (ta: TradeAsset): AssetDescription => {
      const asset = this.repos.assets.getById(ta.assetId) as DraftAsset;
      return { asset, label: this.describeAsset(asset) };
    };
    return {
      trade,
      proposer,
      counterparty,
      gives: assets.filter((a) => a.fromParticipantId === proposer.id).map(describe),
      receives: assets.filter((a) => a.fromParticipantId === counterparty.id).map(describe),
    };
  }

  listOpen(draftId: number): TradeView[] {
    return this.repos.trades.listOpen(draftId).map((t) => this.view(draftId, t.id));
  }

  listRecent(draftId: number, limit = 10): TradeView[] {
    return this.repos.trades.listByDraft(draftId, limit).map((t) => this.view(draftId, t.id));
  }

  /** Human-readable description of an asset ("Team 1234A", "Round 3 pick (#17)"). */
  describeAsset(asset: DraftAsset): string {
    if (asset.assetType === 'team') {
      const team = this.repos.teams.getById(asset.teamId as number) as Team | null;
      const slot = asset.pickSlotId ? this.repos.slots.getById(asset.pickSlotId) : null;
      return `Team ${team?.teamNumber ?? '?'}${slot ? ` (pick #${slot.overallPick})` : ''}`;
    }
    const slot = asset.pickSlotId ? this.repos.slots.getById(asset.pickSlotId) : null;
    if (!slot) return 'a draft pick';
    const original = asset.originalParticipantId !== asset.currentParticipantId ? this.repos.participants.getById(asset.originalParticipantId) : null;
    return `Round ${slot.round} pick (#${slot.overallPick}${original ? `, originally ${original.label}'s` : ''})`;
  }

  /**
   * Resolves user-typed references into asset ids for a participant:
   *  - "1234A" -> team asset the participant owns
   *  - "R3" / "R3.2" -> the participant's 1st/2nd owned pick in round 3
   *  - "#17" -> the pick asset for overall pick 17 (must be owned)
   */
  resolveAssetRefs(draftId: number, participantId: number, refs: string[]): number[] {
    const ctx = loadContext(this.repos, draftId);
    const participant = this.requireParticipant(ctx, participantId);
    const roster = this.repos.assets.listRoster(participantId);
    const picks = this.repos.assets.listFuturePicks(participantId).filter((p) => p.slotStatus === 'pending');
    const used = new Set<number>();
    const out: number[] = [];
    for (const raw of refs) {
      const ref = raw.trim().toUpperCase();
      if (!ref) continue;
      let m: RegExpExecArray | null;
      if ((m = /^#(\d+)$/.exec(ref))) {
        const overall = Number(m[1]);
        const pick = picks.find((p) => p.overallPick === overall && !used.has(p.id));
        if (!pick) throw new DraftError('TRADE_ERROR', `"${participant.label}" does not own an untraded future pick #${overall}.`);
        used.add(pick.id);
        out.push(pick.id);
        continue;
      }
      if ((m = /^R(\d+)(?:[.#-](\d+))?$/.exec(ref))) {
        const round = Number(m[1]);
        const nth = m[2] ? Number(m[2]) : 1;
        const candidates = picks.filter((p) => p.round === round && !used.has(p.id));
        const pick = candidates[nth - 1];
        if (!pick) throw new DraftError('TRADE_ERROR', `"${participant.label}" does not own a tradeable round ${round} pick${nth > 1 ? ` (#${nth})` : ''}. Picks already used or on the clock cannot be traded.`);
        used.add(pick.id);
        out.push(pick.id);
        continue;
      }
      const teamNumber = ref.replace(/\s+/g, '');
      const entry = roster.find((a) => {
        const team = this.repos.teams.getById(a.teamId as number);
        return team?.teamNumber === teamNumber && !used.has(a.id);
      });
      if (!entry) throw new DraftError('TRADE_ERROR', `Team ${teamNumber} is not on "${participant.label}"'s roster. Use team numbers (1234A), rounds (R3) or pick numbers (#17).`);
      used.add(entry.id);
      out.push(entry.id);
    }
    if (out.length === 0) throw new DraftError('TRADE_ERROR', 'List at least one team or pick on each side of the trade.');
    return out;
  }

  // ---------------------------------------------------------------------------

  /**
   * Moves the assets. Returns null on success or the validation failure reason; in that
   * case the trade is marked `failed` (and that write is kept because nothing throws).
   */
  private execute(ctx: DraftContext, trade: Trade, actor: Actor, events: DraftEvent[]): string | null {
    const now = this.clock.nowIso();
    const proposer = this.requireParticipant(ctx, trade.proposerParticipantId);
    const counterparty = this.requireParticipant(ctx, trade.counterpartyParticipantId);
    const tradeAssets = this.repos.trades.listAssets(trade.id);
    const gives = tradeAssets.filter((a) => a.fromParticipantId === proposer.id).map((a) => this.repos.assets.getById(a.assetId) as DraftAsset);
    const receives = tradeAssets.filter((a) => a.fromParticipantId === counterparty.id).map((a) => this.repos.assets.getById(a.assetId) as DraftAsset);
    try {
      this.validate(ctx, proposer, counterparty, gives, receives, trade.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.repos.trades.setStatus(trade.id, 'failed', { resolvedAt: now, resolvedBy: actor.id, resolutionNote: reason });
      this.repos.audit.record({ guildId: ctx.draft.guildId, draftId: ctx.draft.id, eventType: 'trade_failed', actor, summary: `Trade #${trade.id} failed validation at execution: ${reason}`, subject: { tradeId: trade.id }, now });
      events.push({ type: 'trade_failed', draftId: ctx.draft.id, trade: this.repos.trades.getById(trade.id) as Trade, reason });
      return reason;
    }
    const before = [...gives, ...receives].map((a) => ({ assetId: a.id, owner: a.currentParticipantId }));
    for (const a of gives) {
      this.repos.assets.setOwner(a.id, counterparty.id, 'trade', now);
      this.repos.assets.recordTransfer({ draftId: ctx.draft.id, assetId: a.id, from: proposer.id, to: counterparty.id, reason: 'trade', tradeId: trade.id, actor: actor.id, now });
    }
    for (const a of receives) {
      this.repos.assets.setOwner(a.id, proposer.id, 'trade', now);
      this.repos.assets.recordTransfer({ draftId: ctx.draft.id, assetId: a.id, from: counterparty.id, to: proposer.id, reason: 'trade', tradeId: trade.id, actor: actor.id, now });
    }
    // Any other open trade touching these assets is now stale.
    for (const other of this.repos.trades.openTradesForAssets(ctx.draft.id, [...gives, ...receives].map((a) => a.id))) {
      if (other.id === trade.id) continue;
      this.repos.trades.setStatus(other.id, 'cancelled', { resolvedAt: now, resolvedBy: actor.id, resolutionNote: `asset moved by trade #${trade.id}` });
      this.repos.audit.record({ guildId: ctx.draft.guildId, draftId: ctx.draft.id, eventType: 'trade_cancelled', actor, summary: `Trade #${other.id} cancelled: an asset was moved by trade #${trade.id}`, subject: { tradeId: other.id }, now });
    }
    // Prepicks pointing at a traded team instance are irrelevant; nothing to do for picks.
    this.repos.trades.setStatus(trade.id, 'executed', { resolvedAt: now, resolvedBy: actor.id });
    const summary = `"${proposer.label}" traded ${this.describeMany(gives)} to "${counterparty.label}" for ${this.describeMany(receives)}`;
    this.repos.audit.record({
      guildId: ctx.draft.guildId,
      draftId: ctx.draft.id,
      eventType: 'trade_executed',
      actor,
      summary: `Trade #${trade.id} executed: ${summary}`,
      subject: { tradeId: trade.id },
      before,
      after: [...gives, ...receives].map((a) => ({ assetId: a.id, owner: (this.repos.assets.getById(a.id) as DraftAsset).currentParticipantId })),
      now,
    });
    events.push({ type: 'trade_executed', draftId: ctx.draft.id, trade: this.repos.trades.getById(trade.id) as Trade, summary });
    return null;
  }

  private validate(ctx: DraftContext, proposer: ParticipantWithUsers, counterparty: ParticipantWithUsers, gives: DraftAsset[], receives: DraftAsset[], tradeId?: number): void {
    if (gives.length === 0 || receives.length === 0) throw new DraftError('TRADE_ERROR', 'Both sides of a trade must include at least one team or pick.');
    if (gives.length > MAX_ASSETS_PER_SIDE || receives.length > MAX_ASSETS_PER_SIDE) {
      throw new DraftError('TRADE_ERROR', `At most ${MAX_ASSETS_PER_SIDE} assets per side.`);
    }
    if (gives.length !== receives.length && !ctx.config.allowTwoForOne) {
      throw new DraftError('TRADE_ERROR', 'Uneven trades (2-for-1) are not allowed in this draft.');
    }
    const ids = new Set<number>();
    for (const a of [...gives, ...receives]) {
      if (ids.has(a.id)) throw new DraftError('TRADE_ERROR', 'The same asset is listed twice.');
      ids.add(a.id);
    }
    const check = (assets: DraftAsset[], owner: ParticipantWithUsers): void => {
      for (const a of assets) {
        if (a.draftId !== ctx.draft.id) throw new DraftError('TRADE_ERROR', 'An asset belongs to a different draft.');
        if (a.status !== 'active') throw new DraftError('TRADE_ERROR', `${this.describeAsset(a)} is no longer active (${a.status}).`);
        if (a.currentParticipantId !== owner.id) throw new DraftError('TRADE_ERROR', `${this.describeAsset(a)} does not belong to "${owner.label}".`);
        if (a.assetType === 'pick') {
          if (!ctx.config.allowFuturePickTrades) throw new DraftError('TRADE_ERROR', 'Trading future draft picks is not allowed in this draft.');
          const slot = this.repos.slots.getById(a.pickSlotId as number);
          if (!slot || slot.status !== 'pending') throw new DraftError('TRADE_ERROR', `${this.describeAsset(a)} is no longer a future pick.`);
        }
      }
    };
    check(gives, proposer);
    check(receives, counterparty);
    const open = this.repos.trades.openTradesForAssets(ctx.draft.id, [...ids]);
    const conflicting = open.filter((t) => t.id !== tradeId);
    if (conflicting.length > 0) {
      throw new DraftError('TRADE_ERROR', `An asset in this trade is already part of pending trade #${conflicting[0]?.id}. Cancel that trade first.`);
    }
    if (ctx.config.maxRosterSize !== null) {
      const capacity = (p: ParticipantWithUsers, delta: number): void => {
        const teams = this.repos.assets.countActiveTeamAssets(p.id);
        const pending = this.repos.assets.countPendingPickAssets(p.id);
        if (teams + pending + delta > ctx.config.maxRosterSize!) {
          throw new DraftError('TRADE_ERROR', `"${p.label}" would exceed the maximum roster size of ${ctx.config.maxRosterSize} (teams plus remaining picks).`);
        }
      };
      capacity(proposer, receives.length - gives.length);
      capacity(counterparty, gives.length - receives.length);
    }
  }

  private assertTradingOpen(ctx: DraftContext): void {
    if (!ctx.config.allowTrades) throw new DraftError('TRADE_ERROR', 'Trades are disabled for this draft.');
    if (ctx.draft.status === 'active') return;
    if (ctx.draft.status === 'completed' && ctx.config.allowTradesAfterCompletion) return;
    throw new DraftError('TRADE_ERROR', ctx.draft.status === 'completed' ? 'The draft is complete and post-draft trades are not allowed.' : 'Trades are only possible while the draft is running.');
  }

  private loadAssets(ctx: DraftContext, ids: number[]): DraftAsset[] {
    return ids.map((id) => {
      const a = this.repos.assets.getById(id);
      if (!a || a.draftId !== ctx.draft.id) throw new DraftError('ASSET_NOT_FOUND', 'One of the listed teams or picks does not exist in this draft.');
      return a;
    });
  }

  private requireTrade(ctx: DraftContext, tradeId: number): Trade {
    const trade = this.repos.trades.getById(tradeId);
    if (!trade || trade.draftId !== ctx.draft.id) throw new DraftError('TRADE_NOT_FOUND', `Trade #${tradeId} does not exist in this draft.`);
    return trade;
  }

  private requireParticipant(ctx: DraftContext, id: number): ParticipantWithUsers {
    const p = this.repos.participants.getWithUsers(id);
    if (!p || p.draftId !== ctx.draft.id) throw new DraftError('PARTICIPANT_NOT_FOUND', 'That participant is not part of this draft.');
    return p;
  }

  private describeMany(assets: DraftAsset[]): string {
    return assets.map((a) => this.describeAsset(a)).join(' + ');
  }
}
