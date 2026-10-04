import { CsvImporter } from '../../src/engine/csvImport.js';
import { DraftEngine } from '../../src/engine/draftEngine.js';
import { PrepickService } from '../../src/engine/prepickService.js';
import { TradeEngine } from '../../src/engine/tradeEngine.js';
import { silentLogger } from '../../src/logging/logger.js';
import { RecordingAnnouncer } from '../../src/services/announcer.js';
import { DraftService } from '../../src/services/draftService.js';
import { TurnTimerService, type Scheduler } from '../../src/services/timerService.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { FakeClock } from '../../src/util/clock.js';
import { SeededRandom } from '../../src/util/random.js';

/** Deterministic scheduler driven by the FakeClock. */
export class FakeScheduler implements Scheduler {
  private seq = 0;
  readonly pending = new Map<number, { due: number; fn: () => void }>();
  constructor(private readonly clock: FakeClock) {}
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { due: this.clock.nowMs() + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Advances the clock, running every timeout that becomes due (in order). */
  async advance(ms: number): Promise<void> {
    const target = this.clock.nowMs() + ms;
    for (;;) {
      const next = [...this.pending.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.clock.set(new Date(Math.max(next[1].due, this.clock.nowMs())).toISOString());
      this.pending.delete(next[0]);
      next[1].fn();
      // let async handlers settle
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    this.clock.set(new Date(target).toISOString());
  }
}

export interface ServiceEnv {
  repos: Repositories;
  clock: FakeClock;
  scheduler: FakeScheduler;
  announcer: RecordingAnnouncer;
  timers: TurnTimerService;
  service: DraftService;
  engine: DraftEngine;
}

/** Builds a full service stack on the given database path (":memory:" or a file). */
export function createServiceEnv(dbPath = ':memory:', clock = new FakeClock()): ServiceEnv {
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  const engine = new DraftEngine({ repos, clock, random: new SeededRandom(3) });
  const scheduler = new FakeScheduler(clock);
  const announcer = new RecordingAnnouncer();
  const timers: TurnTimerService = new TurnTimerService({
    repos,
    clock,
    logger: silentLogger,
    scheduler,
    onExpire: async (draftId, token): Promise<void> => {
      await service.handleTimerExpiry(draftId, token);
    },
  });
  const service: DraftService = new DraftService({
    repos,
    engine,
    trades: new TradeEngine(repos, clock),
    prepicks: new PrepickService(repos, clock),
    importer: new CsvImporter(repos, clock),
    timers,
    announcer,
    logger: silentLogger,
  });
  return { repos, clock, scheduler, announcer, timers, service, engine };
}
