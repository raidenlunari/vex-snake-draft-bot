import type { Repositories } from '../db/repositories/index.js';
import type { Draft } from '../domain/types.js';
import type { Logger } from '../logging/logger.js';
import type { Clock } from '../util/clock.js';

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface ArmedTimer {
  token: string;
  deadlineMs: number;
  handle: unknown;
}

export interface TurnTimerOptions {
  repos: Repositories;
  clock: Clock;
  logger: Logger;
  onExpire: (draftId: number, token: string) => Promise<void>;
  scheduler?: Scheduler;
  /** Max single setTimeout chunk; long deadlines are re-evaluated in chunks. */
  maxChunkMs?: number;
  /** Interval of the safety sweep that re-checks persisted deadlines. */
  sweepIntervalMs?: number;
}

/**
 * Durable turn timers. The source of truth is `drafts.turn_deadline_at` +
 * `drafts.turn_token`; in-memory timeouts are just a wake-up mechanism. After a
 * restart `recoverAll()` re-arms every active draft and fires overdue deadlines
 * immediately, and a periodic sweep guarantees nothing is missed if a timeout is lost.
 */
export class TurnTimerService {
  private readonly timers = new Map<number, ArmedTimer>();
  private readonly repos: Repositories;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly onExpire: (draftId: number, token: string) => Promise<void>;
  private readonly scheduler: Scheduler;
  private readonly maxChunkMs: number;
  private readonly sweepIntervalMs: number;
  private sweepHandle: unknown = null;
  private readonly firing = new Set<string>();

  constructor(opts: TurnTimerOptions) {
    this.repos = opts.repos;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.onExpire = opts.onExpire;
    this.scheduler = opts.scheduler ?? realScheduler;
    this.maxChunkMs = opts.maxChunkMs ?? 60 * 60 * 1000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60 * 1000;
  }

  /** Arms (or re-arms) the timer for a draft from its persisted turn state. */
  syncFromDraft(draft: Draft): void {
    if (draft.status !== 'active' || !draft.turnDeadlineAt || !draft.turnToken) {
      this.disarm(draft.id);
      return;
    }
    this.arm(draft.id, draft.turnDeadlineAt, draft.turnToken);
  }

  arm(draftId: number, deadlineIso: string, token: string): void {
    const deadlineMs = Date.parse(deadlineIso);
    const existing = this.timers.get(draftId);
    if (existing && existing.token === token && existing.deadlineMs === deadlineMs) return;
    this.disarm(draftId);
    this.schedule(draftId, deadlineMs, token);
    this.logger.debug({ draftId, deadline: deadlineIso, token }, 'turn timer armed');
  }

  disarm(draftId: number): void {
    const existing = this.timers.get(draftId);
    if (!existing) return;
    this.scheduler.clearTimeout(existing.handle);
    this.timers.delete(draftId);
  }

  /** Re-arms every active draft after a restart. Overdue deadlines fire right away. */
  async recoverAll(): Promise<number> {
    let count = 0;
    for (const draft of this.repos.drafts.listByStatus('active')) {
      if (draft.turnDeadlineAt && draft.turnToken) {
        this.syncFromDraft(draft);
        count += 1;
      }
    }
    this.logger.info({ count }, 'turn timers recovered');
    await this.sweep();
    return count;
  }

  /** Checks persisted deadlines directly, firing any that are due. */
  async sweep(): Promise<void> {
    const now = this.clock.nowMs();
    for (const draft of this.repos.drafts.listByStatus('active')) {
      if (!draft.turnDeadlineAt || !draft.turnToken) {
        this.disarm(draft.id);
        continue;
      }
      if (Date.parse(draft.turnDeadlineAt) <= now) {
        await this.fire(draft.id, draft.turnToken);
      } else {
        this.syncFromDraft(draft);
      }
    }
  }

  startSweep(): void {
    if (this.sweepHandle) return;
    const tick = (): void => {
      void this.sweep()
        .catch((err: unknown) => this.logger.error({ err }, 'timer sweep failed'))
        .finally(() => {
          if (this.sweepHandle !== null) this.sweepHandle = this.scheduler.setTimeout(tick, this.sweepIntervalMs);
        });
    };
    this.sweepHandle = this.scheduler.setTimeout(tick, this.sweepIntervalMs);
  }

  stop(): void {
    if (this.sweepHandle !== null) {
      this.scheduler.clearTimeout(this.sweepHandle);
      this.sweepHandle = null;
    }
    for (const id of [...this.timers.keys()]) this.disarm(id);
  }

  armedCount(): number {
    return this.timers.size;
  }

  private schedule(draftId: number, deadlineMs: number, token: string): void {
    const delay = Math.max(0, Math.min(deadlineMs - this.clock.nowMs(), this.maxChunkMs));
    const handle = this.scheduler.setTimeout(() => {
      const armed = this.timers.get(draftId);
      if (!armed || armed.token !== token) return;
      if (this.clock.nowMs() < deadlineMs) {
        // Chunk elapsed but the deadline is still ahead: re-schedule.
        this.timers.delete(draftId);
        this.schedule(draftId, deadlineMs, token);
        return;
      }
      this.timers.delete(draftId);
      void this.fire(draftId, token);
    }, delay);
    this.timers.set(draftId, { token, deadlineMs, handle });
  }

  private async fire(draftId: number, token: string): Promise<void> {
    const key = `${draftId}:${token}`;
    if (this.firing.has(key)) return;
    this.firing.add(key);
    try {
      this.logger.info({ draftId, token }, 'turn timer expired');
      await this.onExpire(draftId, token);
    } catch (err) {
      this.logger.error({ err, draftId }, 'timer expiry handler failed');
    } finally {
      this.firing.delete(key);
    }
  }
}
