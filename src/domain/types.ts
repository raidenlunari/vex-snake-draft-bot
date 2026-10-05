export type DraftStatus = 'setup' | 'randomized' | 'active' | 'completed' | 'archived';
export type ChannelKind = 'text' | 'thread' | 'forum_post';
export type PrepickMode = 'immediate' | 'on_timeout';
export type TradeApproval = 'counterparty' | 'admin' | 'auto';
export type AfterSkipPolicy = 'forfeit' | 'catch_up';
export type SlotStatus = 'pending' | 'current' | 'picked' | 'skipped' | 'forfeited' | 'void';
export type AssetType = 'team' | 'pick';
export type AssetStatus = 'active' | 'consumed' | 'dropped' | 'removed' | 'void';
export type AcquiredVia = 'draft' | 'pick' | 'admin' | 'trade';
export type PickKind = 'pick' | 'prepick' | 'forced' | 'catch_up' | 'admin_add' | 'correction' | 'repick';
export type RepickStatus = 'open' | 'proposed' | 'approved' | 'cancelled';
export type TradeStatus =
  | 'proposed'
  | 'accepted'
  | 'executed'
  | 'rejected'
  | 'cancelled'
  | 'denied'
  | 'failed';
export type ActorKind = 'user' | 'admin' | 'system';

export interface Draft {
  id: number;
  guildId: string;
  name: string;
  status: DraftStatus;
  channelId: string | null;
  channelKind: ChannelKind | null;
  parentChannelId: string | null;
  createdBy: string;
  createdAt: string;
  randomizedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  currentSlotId: number | null;
  turnToken: string | null;
  turnStartedAt: string | null;
  turnDeadlineAt: string | null;
  sheetSpreadsheetId: string | null;
  sheetTab: string | null;
  version: number;
}

export interface DraftConfig {
  /** Expected number of seats; null means "however many are registered". */
  participantCount: number | null;
  rounds: number;
  /** Consecutive picks a seat makes each time its turn comes around. */
  picksPerRound: number;
  snakeOrder: boolean;
  /** null or 0 disables automatic skipping. */
  skipTimerSeconds: number | null;
  /** "HH:MM" local time in `timezone`; null means the timer is always active. */
  skipHoursStart: string | null;
  skipHoursEnd: string | null;
  timezone: string;
  allowPrepicks: boolean;
  prepickMode: PrepickMode;
  allowTrades: boolean;
  allowTwoForOne: boolean;
  allowFuturePickTrades: boolean;
  tradeApproval: TradeApproval;
  allowTradesAfterCompletion: boolean;
  afterSkipPolicy: AfterSkipPolicy;
  /** How many copies of the same team may be drafted (1 = classic unique teams). */
  maxInstancesPerTeam: number;
  /** How many seats one Discord user may control. */
  maxSeatsPerUser: number;
  /** Max teams + pending picks a seat may hold; null = unlimited. */
  maxRosterSize: number | null;
  requirePickConfirmation: boolean;
}

export interface Participant {
  id: number;
  draftId: number;
  label: string;
  draftPosition: number | null;
  createdAt: string;
  createdBy: string;
}

export interface ParticipantUser {
  participantId: number;
  draftId: number;
  discordUserId: string;
  role: 'owner' | 'manager';
  addedAt: string;
}

export interface ParticipantWithUsers extends Participant {
  users: ParticipantUser[];
}

export interface Team {
  id: number;
  draftId: number;
  teamNumber: string;
  teamName: string | null;
  organization: string | null;
  location: string | null;
  extra: Record<string, string> | null;
  /** Per-team override of how many copies may be drafted; null = draft default. */
  maxInstances: number | null;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PickSlot {
  id: number;
  draftId: number;
  overallPick: number;
  round: number;
  pickInRound: number;
  turnInRound: number;
  pickInTurn: number;
  originalParticipantId: number;
  status: SlotStatus;
  skippedAt: string | null;
}

export interface DraftAsset {
  id: number;
  draftId: number;
  assetType: AssetType;
  teamId: number | null;
  pickSlotId: number | null;
  instanceNo: number | null;
  originalParticipantId: number;
  currentParticipantId: number;
  status: AssetStatus;
  acquiredVia: AcquiredVia;
  createdAt: string;
  updatedAt: string;
}

export interface DraftPick {
  id: number;
  draftId: number;
  pickSlotId: number | null;
  overallPick: number | null;
  round: number | null;
  participantId: number;
  teamId: number;
  assetId: number | null;
  kind: PickKind;
  madeBy: string | null;
  madeAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface Prepick {
  id: number;
  draftId: number;
  participantId: number;
  teamId: number;
  priority: number;
  createdBy: string;
  createdAt: string;
}

export interface Trade {
  id: number;
  draftId: number;
  proposerParticipantId: number;
  counterpartyParticipantId: number;
  status: TradeStatus;
  proposedBy: string;
  note: string | null;
  createdAt: string;
  respondedAt: string | null;
  respondedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  messageChannelId: string | null;
  messageId: string | null;
}

export interface TradeAsset {
  tradeId: number;
  assetId: number;
  fromParticipantId: number;
  toParticipantId: number;
}

export interface AssetTransfer {
  id: number;
  draftId: number;
  assetId: number;
  fromParticipantId: number;
  toParticipantId: number;
  reason: 'trade' | 'admin_move';
  tradeId: number | null;
  actor: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: number;
  guildId: string | null;
  draftId: number | null;
  eventType: string;
  actorId: string | null;
  actorKind: ActorKind;
  summary: string;
  subject: unknown;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface GuildSettings {
  guildId: string;
  adminRoleId: string | null;
  updatedAt: string;
}

/** Identifies who performed an action, for audit and permission purposes. */
export interface Actor {
  id: string;
  kind: ActorKind;
}

export const SYSTEM_ACTOR: Actor = { id: 'system', kind: 'system' };

export interface Repick {
  id: number;
  draftId: number;
  participantId: number;
  assetId: number;
  oldTeamId: number;
  pickSlotId: number | null;
  status: RepickStatus;
  proposedTeamId: number | null;
  reason: string | null;
  openedBy: string;
  openedAt: string;
  proposedBy: string | null;
  proposedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}
