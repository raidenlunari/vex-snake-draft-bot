import type {
  AssetTransfer,
  AuditEvent,
  Draft,
  DraftAsset,
  DraftConfig,
  DraftPick,
  GuildSettings,
  Participant,
  ParticipantUser,
  PickSlot,
  Prepick,
  Repick,
  Team,
  Trade,
  TradeAsset,
} from '../../domain/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

const bool = (v: unknown): boolean => v === 1 || v === true;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mapDraft(r: Row): Draft {
  return {
    id: r.id,
    guildId: r.guild_id,
    name: r.name,
    status: r.status,
    channelId: r.channel_id ?? null,
    channelKind: r.channel_kind ?? null,
    parentChannelId: r.parent_channel_id ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    randomizedAt: r.randomized_at ?? null,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    archivedAt: r.archived_at ?? null,
    currentSlotId: num(r.current_slot_id),
    turnToken: r.turn_token ?? null,
    turnStartedAt: r.turn_started_at ?? null,
    turnDeadlineAt: r.turn_deadline_at ?? null,
    sheetSpreadsheetId: r.sheet_spreadsheet_id ?? null,
    sheetTab: r.sheet_tab ?? null,
    version: r.version,
  };
}

export function mapConfig(r: Row): DraftConfig {
  return {
    participantCount: num(r.participant_count),
    rounds: r.rounds,
    picksPerRound: r.picks_per_round,
    snakeOrder: bool(r.snake_order),
    skipTimerSeconds: num(r.skip_timer_seconds),
    skipHoursStart: r.skip_hours_start ?? null,
    skipHoursEnd: r.skip_hours_end ?? null,
    timezone: r.timezone,
    allowPrepicks: bool(r.allow_prepicks),
    prepickMode: r.prepick_mode,
    allowTrades: bool(r.allow_trades),
    allowTwoForOne: bool(r.allow_two_for_one),
    allowFuturePickTrades: bool(r.allow_future_pick_trades),
    tradeApproval: r.trade_approval,
    allowTradesAfterCompletion: bool(r.allow_trades_after_completion),
    afterSkipPolicy: r.after_skip_policy,
    maxInstancesPerTeam: r.max_instances_per_team,
    maxSeatsPerUser: r.max_seats_per_user,
    maxRosterSize: num(r.max_roster_size),
    requirePickConfirmation: bool(r.require_pick_confirmation),
  };
}

export function configToRow(c: DraftConfig): Row {
  return {
    participant_count: c.participantCount,
    rounds: c.rounds,
    picks_per_round: c.picksPerRound,
    snake_order: c.snakeOrder ? 1 : 0,
    skip_timer_seconds: c.skipTimerSeconds,
    skip_hours_start: c.skipHoursStart,
    skip_hours_end: c.skipHoursEnd,
    timezone: c.timezone,
    allow_prepicks: c.allowPrepicks ? 1 : 0,
    prepick_mode: c.prepickMode,
    allow_trades: c.allowTrades ? 1 : 0,
    allow_two_for_one: c.allowTwoForOne ? 1 : 0,
    allow_future_pick_trades: c.allowFuturePickTrades ? 1 : 0,
    trade_approval: c.tradeApproval,
    allow_trades_after_completion: c.allowTradesAfterCompletion ? 1 : 0,
    after_skip_policy: c.afterSkipPolicy,
    max_instances_per_team: c.maxInstancesPerTeam,
    max_seats_per_user: c.maxSeatsPerUser,
    max_roster_size: c.maxRosterSize,
    require_pick_confirmation: c.requirePickConfirmation ? 1 : 0,
  };
}

export function mapParticipant(r: Row): Participant {
  return {
    id: r.id,
    draftId: r.draft_id,
    label: r.label,
    draftPosition: num(r.draft_position),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export function mapParticipantUser(r: Row): ParticipantUser {
  return {
    participantId: r.participant_id,
    draftId: r.draft_id,
    discordUserId: r.discord_user_id,
    role: r.role,
    addedAt: r.added_at,
  };
}

export function mapTeam(r: Row): Team {
  return {
    id: r.id,
    draftId: r.draft_id,
    teamNumber: r.team_number,
    teamName: r.team_name ?? null,
    organization: r.organization ?? null,
    location: r.location ?? null,
    extra: r.extra_json ? (JSON.parse(r.extra_json) as Record<string, string>) : null,
    maxInstances: num(r.max_instances),
    removedAt: r.removed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapSlot(r: Row): PickSlot {
  return {
    id: r.id,
    draftId: r.draft_id,
    overallPick: r.overall_pick,
    round: r.round,
    pickInRound: r.pick_in_round,
    turnInRound: r.turn_in_round,
    pickInTurn: r.pick_in_turn,
    originalParticipantId: r.original_participant_id,
    status: r.status,
    skippedAt: r.skipped_at ?? null,
  };
}

export function mapAsset(r: Row): DraftAsset {
  return {
    id: r.id,
    draftId: r.draft_id,
    assetType: r.asset_type,
    teamId: num(r.team_id),
    pickSlotId: num(r.pick_slot_id),
    instanceNo: num(r.instance_no),
    originalParticipantId: r.original_participant_id,
    currentParticipantId: r.current_participant_id,
    status: r.status,
    acquiredVia: r.acquired_via,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapPick(r: Row): DraftPick {
  return {
    id: r.id,
    draftId: r.draft_id,
    pickSlotId: num(r.pick_slot_id),
    overallPick: num(r.overall_pick),
    round: num(r.round),
    participantId: r.participant_id,
    teamId: r.team_id,
    assetId: num(r.asset_id),
    kind: r.kind,
    madeBy: r.made_by ?? null,
    madeAt: r.made_at,
    voidedAt: r.voided_at ?? null,
    voidedBy: r.voided_by ?? null,
    voidReason: r.void_reason ?? null,
  };
}

export function mapPrepick(r: Row): Prepick {
  return {
    id: r.id,
    draftId: r.draft_id,
    participantId: r.participant_id,
    teamId: r.team_id,
    priority: r.priority,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export function mapTrade(r: Row): Trade {
  return {
    id: r.id,
    draftId: r.draft_id,
    proposerParticipantId: r.proposer_participant_id,
    counterpartyParticipantId: r.counterparty_participant_id,
    status: r.status,
    proposedBy: r.proposed_by,
    note: r.note ?? null,
    createdAt: r.created_at,
    respondedAt: r.responded_at ?? null,
    respondedBy: r.responded_by ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolvedBy: r.resolved_by ?? null,
    resolutionNote: r.resolution_note ?? null,
    messageChannelId: r.message_channel_id ?? null,
    messageId: r.message_id ?? null,
  };
}

export function mapTradeAsset(r: Row): TradeAsset {
  return {
    tradeId: r.trade_id,
    assetId: r.asset_id,
    fromParticipantId: r.from_participant_id,
    toParticipantId: r.to_participant_id,
  };
}

export function mapTransfer(r: Row): AssetTransfer {
  return {
    id: r.id,
    draftId: r.draft_id,
    assetId: r.asset_id,
    fromParticipantId: r.from_participant_id,
    toParticipantId: r.to_participant_id,
    reason: r.reason,
    tradeId: num(r.trade_id),
    actor: r.actor ?? null,
    createdAt: r.created_at,
  };
}

export function mapAudit(r: Row): AuditEvent {
  const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : null);
  return {
    id: r.id,
    guildId: r.guild_id ?? null,
    draftId: num(r.draft_id),
    eventType: r.event_type,
    actorId: r.actor_id ?? null,
    actorKind: r.actor_kind,
    summary: r.summary,
    subject: parse(r.subject_json),
    before: parse(r.before_json),
    after: parse(r.after_json),
    createdAt: r.created_at,
  };
}

export function mapGuildSettings(r: Row): GuildSettings {
  return { guildId: r.guild_id, adminRoleId: r.admin_role_id ?? null, updatedAt: r.updated_at };
}

export function mapRepick(r: Row): Repick {
  return {
    id: r.id,
    draftId: r.draft_id,
    participantId: r.participant_id,
    assetId: r.asset_id,
    oldTeamId: r.old_team_id,
    pickSlotId: num(r.pick_slot_id),
    status: r.status,
    proposedTeamId: num(r.proposed_team_id),
    reason: r.reason ?? null,
    openedBy: r.opened_by,
    openedAt: r.opened_at,
    proposedBy: r.proposed_by ?? null,
    proposedAt: r.proposed_at ?? null,
    resolvedBy: r.resolved_by ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolutionNote: r.resolution_note ?? null,
  };
}
