import { openDatabase, type SqliteDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import type { DraftConfig, ParticipantWithUsers, Team } from '../../src/domain/types.js';
import { CsvImporter } from '../../src/engine/csvImport.js';
import { DraftEngine } from '../../src/engine/draftEngine.js';
import { PrepickService } from '../../src/engine/prepickService.js';
import { TradeEngine } from '../../src/engine/tradeEngine.js';
import { FakeClock } from '../../src/util/clock.js';
import { SeededRandom } from '../../src/util/random.js';
import type { Actor } from '../../src/domain/types.js';

export const ADMIN: Actor = { id: 'admin-1', kind: 'admin' };
export const user = (id: string): Actor => ({ id, kind: 'user' });

export interface TestEnv {
  db: SqliteDatabase;
  repos: Repositories;
  clock: FakeClock;
  random: SeededRandom;
  engine: DraftEngine;
  prepicks: PrepickService;
  trades: TradeEngine;
  importer: CsvImporter;
}

export function createTestEnv(dbPath = ':memory:'): TestEnv {
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  const clock = new FakeClock();
  const random = new SeededRandom(7);
  const engine = new DraftEngine({ repos, clock, random });
  return {
    db,
    repos,
    clock,
    random,
    engine,
    prepicks: new PrepickService(repos, clock),
    trades: new TradeEngine(repos, clock),
    importer: new CsvImporter(repos, clock),
  };
}

export interface SetupOptions {
  participants?: number;
  teams?: number;
  config?: Partial<DraftConfig>;
  guildId?: string;
  start?: boolean;
  randomize?: boolean;
}

export interface SetupResult {
  draftId: number;
  participants: ParticipantWithUsers[];
  teams: Team[];
  /** participants ordered by draft position (after randomize) */
  order: ParticipantWithUsers[];
}

/** Creates a draft with N participants (users u1..uN) and M teams (T1..TM). */
export function setupDraft(env: TestEnv, opts: SetupOptions = {}): SetupResult {
  const n = opts.participants ?? 4;
  const m = opts.teams ?? 40;
  const guildId = opts.guildId ?? 'guild-1';
  const draft = env.engine.createDraft({ guildId, name: 'Test Draft', actor: ADMIN });
  env.engine.updateConfig(draft.id, { rounds: 3, ...opts.config }, ADMIN);
  env.engine.setChannel(draft.id, { channelId: 'chan-1', kind: 'text', parentChannelId: null }, ADMIN);
  const participants: ParticipantWithUsers[] = [];
  for (let i = 1; i <= n; i++) {
    participants.push(env.engine.addParticipant(draft.id, { label: `Player ${i}`, discordUserIds: [`u${i}`], actor: ADMIN }));
  }
  const teams: Team[] = [];
  for (let i = 1; i <= m; i++) {
    teams.push(env.engine.addTeam(draft.id, { teamNumber: `${1000 + i}A`, teamName: `Team ${i}`, organization: null, location: null }, ADMIN));
  }
  let order: ParticipantWithUsers[] = participants;
  if (opts.randomize !== false) {
    order = env.engine.randomize(draft.id, ADMIN);
  }
  if (opts.start) {
    env.engine.start(draft.id, ADMIN);
    order = env.repos.participants.listWithUsers(draft.id);
  }
  return { draftId: draft.id, participants, teams, order };
}

export function teamByNumber(env: TestEnv, draftId: number, teamNumber: string): Team {
  const t = env.repos.teams.getByNumber(draftId, teamNumber);
  if (!t) throw new Error(`no team ${teamNumber}`);
  return t;
}

/** Picks the first available team for whoever is on the clock, as that user. */
export function pickNextAvailable(env: TestEnv, draftId: number): void {
  const turn = env.engine.currentTurn(draftId);
  if (!turn) throw new Error('no current turn');
  const config = env.repos.drafts.getConfig(draftId);
  const available = env.repos.teams.listAvailable(draftId, config.maxInstancesPerTeam, undefined, 1)[0];
  if (!available) throw new Error('no teams available');
  const userId = turn.owner.users[0]?.discordUserId;
  env.engine.pick(draftId, { participantId: turn.owner.id, teamId: available.id, actor: userId ? user(userId) : ADMIN });
}
