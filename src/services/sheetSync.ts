import type { Repositories } from '../db/repositories/index.js';
import type { Draft, ParticipantWithUsers } from '../domain/types.js';
import type { DraftEngine } from '../engine/draftEngine.js';
import type { SheetsClient } from '../integrations/googleSheets.js';
import { detectLayout, planLayoutFill } from './sheetLayout.js';
import type { Logger } from '../logging/logger.js';

const AVAILABLE_COLUMNS = 7;

/**
 * Renders the draft as a grid shaped like the club's traditional tracking sheet:
 *
 *   <draft name>
 *   Drafter | Pick 1 | Pick 2 | ... | Pick N
 *   <seat>  | 1234A  | ...
 *   ...
 *   Available Teams (k)              | Picks per team | N
 *   10G  12A  12M ... (7 per row)    | Status         | Round 3 · Pick #17 · <seat>
 */
export function renderDraftSheet(engine: DraftEngine, repos: Repositories, draftId: number): string[][] {
  const state = engine.getState(draftId);
  const { draft, config } = state;
  const participants: ParticipantWithUsers[] = state.participants;
  const rosters = participants.map((p) => engine.getRoster(draftId, p.id));
  const picksPerSeat = config.rounds * config.picksPerRound;
  const columns = Math.max(picksPerSeat, ...rosters.map((r) => r.teams.length), 1);

  const rows: string[][] = [];
  rows.push([draft.name]);
  rows.push(['Drafter', ...Array.from({ length: columns }, (_, i) => `Pick ${i + 1}`)]);
  participants.forEach((p, i) => {
    const roster = rosters[i]!;
    const cells = roster.teams.map((t) => t.team.teamNumber);
    rows.push([seatLabel(p), ...cells, ...Array.from({ length: columns - cells.length }, () => '')]);
  });
  rows.push([]);

  const available = repos.teams.listAvailable(draftId, config.maxInstancesPerTeam, undefined, 10000).map((t) => t.teamNumber);
  const infoCol = AVAILABLE_COLUMNS + 1;
  const pad = (cells: string[], upTo: number): string[] => [...cells, ...Array.from({ length: Math.max(0, upTo - cells.length) }, () => '')];
  const status =
    draft.status === 'active' && state.currentSlot
      ? `Round ${state.currentSlot.round} · Pick #${state.currentSlot.overallPick} of ${state.totalSlots} · On the clock: ${state.currentOwner ? seatLabel(state.currentOwner) : '—'}`
      : draft.status === 'completed'
        ? 'Draft complete'
        : draft.status === 'randomized'
          ? 'Order randomized, waiting to start'
          : 'Setting up';
  const info: Array<[string, string]> = [
    ['Picks per team', String(picksPerSeat)],
    ['Status', status],
    ['Skip timer', config.skipTimerSeconds ? `${Math.round(config.skipTimerSeconds / 60)} min${config.skipHoursStart ? ` (${config.skipHoursStart}–${config.skipHoursEnd} ${config.timezone})` : ''}` : 'off (admins skip with discretion)'],
    ['Updated', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
  ];
  const grid: string[][] = [];
  for (let i = 0; i < available.length; i += AVAILABLE_COLUMNS) grid.push(available.slice(i, i + AVAILABLE_COLUMNS));
  const headerRow = pad([`Available Teams (${available.length})`], infoCol);
  rows.push(headerRow);
  const bodyRows = Math.max(grid.length, info.length);
  for (let i = 0; i < bodyRows; i++) {
    const row = pad(grid[i] ?? [], infoCol);
    const entry = info[i];
    if (entry) row.push(entry[0], entry[1]);
    rows.push(row);
  }
  // Open catch-up picks and pending trades are useful on the sheet too.
  if (state.openSkippedSlots.length) {
    rows.push([]);
    rows.push(['Open catch-up picks', ...state.openSkippedSlots.map((s) => `#${s.slot.overallPick} ${seatLabel(s.owner)}`)]);
  }
  return rows;
}

function seatLabel(p: ParticipantWithUsers): string {
  return p.label;
}

export interface SheetSyncOptions {
  client: SheetsClient | null;
  repos: Repositories;
  engine: DraftEngine;
  logger: Logger;
  debounceMs?: number;
}

/**
 * Keeps a Google Sheet tab in step with the draft. Writes are debounced per draft so a
 * burst of changes (a chain of prepicks) produces a single API call, and failures are
 * logged without ever affecting the draft itself.
 */
export class SheetSyncService {
  private readonly pending = new Map<number, NodeJS.Timeout>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly dirty = new Set<number>();
  readonly client: SheetsClient | null;
  private readonly repos: Repositories;
  private readonly engine: DraftEngine;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  public lastError = new Map<number, string>();
  /** Seats that had no matching row in the user's sheet and were appended. */
  public lastUnmatched = new Map<number, string[]>();

  constructor(opts: SheetSyncOptions) {
    this.client = opts.client;
    this.repos = opts.repos;
    this.engine = opts.engine;
    this.logger = opts.logger;
    this.debounceMs = opts.debounceMs ?? 1500;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Schedules a (debounced) sync if the draft has a sheet configured. */
  schedule(draftId: number): void {
    if (!this.client) return;
    const draft = this.repos.drafts.getById(draftId);
    if (!draft?.sheetSpreadsheetId) return;
    const existing = this.pending.get(draftId);
    if (existing) clearTimeout(existing);
    this.pending.set(
      draftId,
      setTimeout(() => {
        this.pending.delete(draftId);
        void this.syncNow(draftId).catch(() => undefined);
      }, this.debounceMs),
    );
  }

  /** Writes immediately (serialized per draft). Throws on failure so commands can report it. */
  async syncNow(draftId: number): Promise<void> {
    if (!this.client) throw new Error('Google Sheets sync is not configured on this bot (GOOGLE_SERVICE_ACCOUNT_FILE).');
    const running = this.inFlight.get(draftId);
    if (running) {
      this.dirty.add(draftId);
      await running.catch(() => undefined);
      if (!this.dirty.has(draftId)) return;
    }
    this.dirty.delete(draftId);
    const task = this.write(draftId);
    this.inFlight.set(draftId, task);
    try {
      await task;
    } finally {
      if (this.inFlight.get(draftId) === task) this.inFlight.delete(draftId);
      if (this.dirty.has(draftId)) void this.syncNow(draftId).catch(() => undefined);
    }
  }

  stop(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private async write(draftId: number): Promise<void> {
    const draft = this.repos.drafts.getById(draftId);
    if (!draft?.sheetSpreadsheetId || !this.client) return;
    const tab = draft.sheetTab ?? 'Draft';
    try {
      const existing = await this.client.readTab(draft.sheetSpreadsheetId, tab);
      if (detectLayout(existing)) {
        // The user's own layout: fill the Drafter/Pick columns and the Available Teams block in place.
        const state = this.engine.getState(draftId);
        const plan = planLayoutFill({
          existing,
          drafters: state.grid.map((g) => ({ label: g.participant.label, picks: g.picks })),
          availableTeams: this.repos.teams.listAvailable(draftId, state.config.maxInstancesPerTeam, undefined, 10000).map((t) => t.teamNumber),
          picksPerSeat: state.config.rounds * state.config.picksPerRound,
          notes: [
            ['Picks per team', String(state.config.rounds * state.config.picksPerRound)],
            ['Status', state.draft.status === 'active' && state.currentSlot ? `Round ${state.currentSlot.round} · Pick #${state.currentSlot.overallPick} · ${state.currentOwner?.label ?? ''} is up` : state.draft.status],
          ],
        });
        await this.client.updateRanges(draft.sheetSpreadsheetId, tab, plan.writes, plan.clears);
        this.lastUnmatched.set(draftId, plan.unmatched);
        this.logger.debug({ draftId, writes: plan.writes.length, unmatched: plan.unmatched }, 'sheet filled in place');
      } else {
        const values = renderDraftSheet(this.engine, this.repos, draftId);
        await this.client.writeTab(draft.sheetSpreadsheetId, tab, values);
        this.lastUnmatched.delete(draftId);
        this.logger.debug({ draftId, rows: values.length }, 'sheet rewritten');
      }
      this.lastError.delete(draftId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(draftId, message);
      this.logger.error({ err, draftId, spreadsheetId: draft.sheetSpreadsheetId }, 'sheet sync failed');
      throw err;
    }
  }
}

export function describeSheet(draft: Draft): string {
  return draft.sheetSpreadsheetId ? `https://docs.google.com/spreadsheets/d/${draft.sheetSpreadsheetId}/edit (tab "${draft.sheetTab ?? 'Draft'}")` : 'not set';
}
