import type { SqliteDatabase } from '../connection.js';
import { AssetRepository } from './assetRepository.js';
import { AuditRepository } from './auditRepository.js';
import { DraftRepository } from './draftRepository.js';
import { ParticipantRepository } from './participantRepository.js';
import { PickRepository } from './pickRepository.js';
import { PrepickRepository } from './prepickRepository.js';
import { SlotRepository } from './slotRepository.js';
import { TeamRepository } from './teamRepository.js';
import { TradeRepository } from './tradeRepository.js';

export interface Repositories {
  db: SqliteDatabase;
  drafts: DraftRepository;
  participants: ParticipantRepository;
  teams: TeamRepository;
  slots: SlotRepository;
  assets: AssetRepository;
  picks: PickRepository;
  prepicks: PrepickRepository;
  trades: TradeRepository;
  audit: AuditRepository;
}

export function createRepositories(db: SqliteDatabase): Repositories {
  return {
    db,
    drafts: new DraftRepository(db),
    participants: new ParticipantRepository(db),
    teams: new TeamRepository(db),
    slots: new SlotRepository(db),
    assets: new AssetRepository(db),
    picks: new PickRepository(db),
    prepicks: new PrepickRepository(db),
    trades: new TradeRepository(db),
    audit: new AuditRepository(db),
  };
}

export { AssetRepository, AuditRepository, DraftRepository, ParticipantRepository, PickRepository, PrepickRepository, SlotRepository, TeamRepository, TradeRepository };
