import type { Repositories } from '../db/repositories/index.js';
import type { Actor, ChannelKind, Draft, DraftConfig, PickKind } from '../domain/types.js';
import type { CsvImporter, ImportMode, ImportSummary } from '../engine/csvImport.js';
import type { DraftEngine } from '../engine/draftEngine.js';
import type { DraftEvent } from '../engine/events.js';
import type { PrepickService } from '../engine/prepickService.js';
import type { ProposeTradeInput, TradeEngine, TradeResolution, TradeView } from '../engine/tradeEngine.js';
import type { Logger } from '../logging/logger.js';
import type { Announcer } from './announcer.js';
import { renderEvents } from './eventMessages.js';
import { KeyedMutex } from './lock.js';
import type { TurnTimerService } from './timerService.js';
import type { SheetSyncService } from './sheetSync.js';

export interface DraftServiceDeps {
  repos: Repositories;
  engine: DraftEngine;
  trades: TradeEngine;
  prepicks: PrepickService;
  importer: CsvImporter;
  timers: TurnTimerService;
  announcer: Announcer;
  logger: Logger;
  lock?: KeyedMutex;
  sheets?: SheetSyncService;
}

/**
 * Application service. Every mutation runs under the per-draft lock; after the
 * engine commits, the resulting events are announced and the turn timer is
 * re-synchronized from the persisted draft row.
 */
export class DraftService {
  readonly repos: Repositories;
  readonly engine: DraftEngine;
  readonly trades: TradeEngine;
  readonly prepicks: PrepickService;
  readonly importer: CsvImporter;
  readonly timers: TurnTimerService;
  readonly announcer: Announcer;
  readonly logger: Logger;
  readonly sheets: SheetSyncService | null;
  private readonly lock: KeyedMutex;

  constructor(deps: DraftServiceDeps) {
    this.repos = deps.repos;
    this.engine = deps.engine;
    this.trades = deps.trades;
    this.prepicks = deps.prepicks;
    this.importer = deps.importer;
    this.timers = deps.timers;
    this.announcer = deps.announcer;
    this.logger = deps.logger;
    this.lock = deps.lock ?? new KeyedMutex();
    this.sheets = deps.sheets ?? null;
  }

  /** Marks the draft changed for the (optional) Google Sheet mirror. */
  touch(draftId: number): void {
    this.sheets?.schedule(draftId);
  }

  // --- lifecycle -------------------------------------------------------------

  async start(draftId: number, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.start(draftId, actor));
  }

  async complete(draftId: number, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.complete(draftId, actor));
  }

  async reset(draftId: number, actor: Actor, purge: boolean): Promise<{ draft: Draft; purged: boolean }> {
    return this.lock.run(this.key(draftId), async () => {
      const result = this.engine.reset(draftId, actor, { purge });
      this.timers.disarm(draftId);
      return result;
    });
  }

  async updateConfig(draftId: number, patch: Partial<DraftConfig>, actor: Actor): Promise<{ before: DraftConfig; after: DraftConfig }> {
    return this.lock.run(this.key(draftId), async () => {
      const result = this.engine.updateConfig(draftId, patch, actor);
      const draft = this.repos.drafts.getById(draftId);
      if (draft) this.timers.syncFromDraft(draft);
      this.touch(draftId);
      return result;
    });
  }

  async setChannel(draftId: number, channel: { channelId: string; kind: ChannelKind; parentChannelId: string | null } | null, actor: Actor): Promise<Draft> {
    return this.lock.run(this.key(draftId), async () => this.engine.setChannel(draftId, channel, actor));
  }

  async importTeams(draftId: number, csv: string, actor: Actor, mode: ImportMode): Promise<ImportSummary> {
    return this.lock.run(this.key(draftId), async () => {
      const summary = this.importer.importTeams(draftId, csv, actor, mode);
      this.touch(draftId);
      return summary;
    });
  }

  // --- picks -----------------------------------------------------------------

  async pick(draftId: number, input: { participantId: number; teamId: number; actor: Actor; kind?: PickKind }): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.pick(draftId, input));
  }

  async skip(draftId: number, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.skipCurrent(draftId, actor, 'admin'));
  }

  /** Timer callback. Safe to call multiple times with the same token. */
  async handleTimerExpiry(draftId: number, token: string): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.expireTurn(draftId, token));
  }

  // --- admin roster ----------------------------------------------------------

  async adminAddTeam(draftId: number, participantId: number, teamId: number, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.adminAddTeam(draftId, participantId, teamId, actor));
  }

  async adminReplaceTeam(draftId: number, target: { participantId: number; oldTeamId: number } | { overallPick: number }, newTeamId: number, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.adminReplaceTeam(draftId, target, newTeamId, actor));
  }

  async adminDropTeam(draftId: number, participantId: number, teamId: number, removeFromPool: boolean, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.adminDropTeam(draftId, participantId, teamId, { removeFromPool }, actor));
  }

  async adminMoveTeam(draftId: number, from: number, to: number, teamId: number, actor: Actor): Promise<DraftEvent[]> {
    return this.mutate(draftId, () => this.engine.adminMoveTeam(draftId, from, to, teamId, actor));
  }

  async removeTeam(draftId: number, teamId: number, force: boolean, actor: Actor): Promise<ReturnType<DraftEngine['removeTeam']>> {
    return this.lock.run(this.key(draftId), async () => {
      const result = this.engine.removeTeam(draftId, teamId, { force }, actor);
      if (result.droppedFrom.length > 0) {
        await this.announceEvents(draftId, [
          { type: 'roster_changed', draftId, summary: `${result.team.teamNumber} was removed from the draft and dropped from ${result.droppedFrom.map((p) => p.label).join(', ')}`, actorId: actor.id },
        ]);
      }
      this.touch(draftId);
      return result;
    });
  }

  async restoreTeam(draftId: number, teamId: number, actor: Actor): Promise<ReturnType<DraftEngine['restoreTeam']>> {
    return this.lock.run(this.key(draftId), async () => {
      const team = this.engine.restoreTeam(draftId, teamId, actor);
      this.touch(draftId);
      return team;
    });
  }

  // --- trades ----------------------------------------------------------------

  async proposeTrade(draftId: number, input: ProposeTradeInput): Promise<{ view: TradeView; failure: string | null }> {
    return this.lock.run(this.key(draftId), async () => {
      const { view, events, failure } = this.trades.propose(draftId, input);
      await this.announceEvents(draftId, events);
      if (view.trade.status === 'executed') this.touch(draftId);
      return { view, failure };
    });
  }

  async respondTrade(draftId: number, tradeId: number, accept: boolean, actor: Actor): Promise<TradeResolution> {
    return this.lock.run(this.key(draftId), async () => {
      const result = this.trades.respond(draftId, tradeId, accept, actor);
      await this.announceEvents(draftId, result.events);
      if (result.executed) this.touch(draftId);
      return result;
    });
  }

  async adminResolveTrade(draftId: number, tradeId: number, approve: boolean, actor: Actor): Promise<TradeResolution> {
    return this.lock.run(this.key(draftId), async () => {
      const result = this.trades.adminResolve(draftId, tradeId, approve, actor);
      await this.announceEvents(draftId, result.events);
      if (result.executed) this.touch(draftId);
      return result;
    });
  }

  async cancelTrade(draftId: number, tradeId: number, actor: Actor): Promise<TradeView> {
    return this.lock.run(this.key(draftId), async () => this.trades.cancel(draftId, tradeId, actor));
  }

  // --- prepicks (no announcements; serialized so they cannot race a turn) ----

  async withDraftLock<T>(draftId: number, fn: () => Promise<T> | T): Promise<T> {
    return this.lock.run(this.key(draftId), fn);
  }

  // --- internals -------------------------------------------------------------

  private key(draftId: number): string {
    return `draft:${draftId}`;
  }

  private async mutate(draftId: number, op: () => DraftEvent[]): Promise<DraftEvent[]> {
    return this.lock.run(this.key(draftId), async () => {
      const events = op();
      await this.afterCommit(draftId, events);
      return events;
    });
  }

  private async afterCommit(draftId: number, events: DraftEvent[]): Promise<void> {
    const draft = this.repos.drafts.getById(draftId);
    if (draft) this.timers.syncFromDraft(draft);
    await this.announceEvents(draftId, events);
    this.touch(draftId);
  }

  private async announceEvents(draftId: number, events: DraftEvent[]): Promise<void> {
    if (events.length === 0) return;
    const draft = this.repos.drafts.getById(draftId);
    if (!draft) return;
    const config = this.repos.drafts.getConfig(draftId);
    for (const payload of renderEvents(events, config)) {
      try {
        await this.announcer.announce(draft, payload);
      } catch (err) {
        this.logger.error({ err, draftId }, 'failed to announce draft event');
      }
    }
  }
}
