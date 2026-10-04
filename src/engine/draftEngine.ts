import { inTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import { computeDeadline, type ActiveWindow } from '../domain/activeHours.js';
import { assertConfigChangeAllowed, defaultDraftConfig, validateConfig } from '../domain/config.js';
import { DraftError } from '../domain/errors.js';
import { generatePickOrder } from '../domain/snakeOrder.js';
import type {
  Actor,
  ChannelKind,
  Draft,
  DraftConfig,
  DraftPick,
  Participant,
  ParticipantWithUsers,
  PickKind,
  PickSlot,
  Team,
} from '../domain/types.js';
import { SYSTEM_ACTOR } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import { shuffle, type RandomSource } from '../util/random.js';
import { loadContext, requireStatus, type DraftContext } from './context.js';
import type { DraftEvent } from './events.js';

export interface EngineDeps {
  repos: Repositories;
  clock: Clock;
  random: RandomSource;
}

export interface StartValidation {
  errors: string[];
  warnings: string[];
}

export interface RosterEntry {
  assetId: number;
  team: Team;
  overallPick: number | null;
  round: number | null;
  acquiredVia: string;
  originalOwner: ParticipantWithUsers | null;
  transfers: Array<{ from: ParticipantWithUsers | null; to: ParticipantWithUsers | null; reason: string; tradeId: number | null; at: string }>;
}

export interface RosterView {
  participant: ParticipantWithUsers;
  teams: RosterEntry[];
  futurePicks: Array<{ assetId: number; overallPick: number; round: number; originalOwner: ParticipantWithUsers | null; slotStatus: string }>;
  totalPicks: number;
  maxRoster: number | null;
}

export interface TeamInfoView {
  team: Team;
  available: boolean;
  removed: boolean;
  instancesUsed: number;
  maxInstances: number;
  owners: Array<{
    participant: ParticipantWithUsers;
    overallPick: number | null;
    round: number | null;
    viaTrade: boolean;
    originalOwner: ParticipantWithUsers | null;
    acquiredVia: string;
  }>;
}

export interface DraftStateView {
  draft: Draft;
  config: DraftConfig;
  participants: ParticipantWithUsers[];
  currentSlot: PickSlot | null;
  currentOwner: ParticipantWithUsers | null;
  totalSlots: number;
  resolvedSlots: number;
  availableTeams: number;
  totalTeams: number;
  recentPicks: Array<{ pick: DraftPick; team: Team; participant: ParticipantWithUsers }>;
  upcoming: Array<{ slot: PickSlot; owner: ParticipantWithUsers }>;
  currentOwnerRosterCount: number;
  openSkippedSlots: Array<{ slot: PickSlot; owner: ParticipantWithUsers }>;
}

/**
 * The draft engine. Every public mutating method runs inside a single
 * BEGIN IMMEDIATE transaction and returns the events that occurred. It is fully
 * synchronous and independent of Discord.
 */
export class DraftEngine {
  private readonly repos: Repositories;
  private readonly clock: Clock;
  private readonly random: RandomSource;

  constructor(deps: EngineDeps) {
    this.repos = deps.repos;
    this.clock = deps.clock;
    this.random = deps.random;
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  createDraft(input: { guildId: string; name: string; actor: Actor; timezone?: string }): Draft {
    return this.tx(() => {
      const existing = this.repos.drafts.getOpenForGuild(input.guildId);
      if (existing) {
        throw new DraftError(
          'DRAFT_EXISTS',
          `A draft ("${existing.name}") is already ${existing.status === 'active' ? 'running' : 'being set up'}. Use /draft reset to clear it first.`,
        );
      }
      const now = this.clock.nowIso();
      const config = defaultDraftConfig(input.timezone ?? 'UTC');
      const draft = this.repos.drafts.create({ guildId: input.guildId, name: input.name, createdBy: input.actor.id, now, config });
      this.audit(draft.guildId, draft.id, 'draft_created', input.actor, `Draft "${draft.name}" created`, { draftId: draft.id }, undefined, config);
      return draft;
    });
  }

  renameDraft(draftId: number, name: string, actor: Actor): Draft {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      this.repos.drafts.setName(draftId, name);
      this.audit(ctx.draft.guildId, draftId, 'draft_renamed', actor, `Draft renamed to "${name}"`, undefined, { name: ctx.draft.name }, { name });
      return this.repos.drafts.getById(draftId) as Draft;
    });
  }

  updateConfig(draftId: number, patch: Partial<DraftConfig>, actor: Actor): { before: DraftConfig; after: DraftConfig } {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      const keys = Object.keys(patch) as Array<keyof DraftConfig>;
      assertConfigChangeAllowed(ctx.draft.status, keys);
      const after: DraftConfig = { ...ctx.config, ...patch };
      const problems = validateConfig(after);
      if (problems.length > 0) {
        throw new DraftError('INVALID_CONFIG', problems.join(' '));
      }
      this.repos.drafts.saveConfig(draftId, after, this.clock.nowIso());
      const timerKeys: Array<keyof DraftConfig> = ['skipTimerSeconds', 'skipHoursStart', 'skipHoursEnd', 'timezone'];
      if (ctx.draft.status === 'active' && ctx.draft.currentSlotId && ctx.draft.turnStartedAt && keys.some((k) => timerKeys.includes(k))) {
        // Re-derive the running turn's deadline from its start time under the new rules.
        this.repos.drafts.setTurn(draftId, {
          currentSlotId: ctx.draft.currentSlotId,
          turnToken: ctx.draft.turnToken,
          turnStartedAt: ctx.draft.turnStartedAt,
          turnDeadlineAt: this.deadlineFor(after, ctx.draft.turnStartedAt),
        });
      }
      const beforeSubset: Partial<DraftConfig> = {};
      const afterSubset: Partial<DraftConfig> = {};
      for (const k of keys) {
        (beforeSubset as Record<string, unknown>)[k] = ctx.config[k];
        (afterSubset as Record<string, unknown>)[k] = after[k];
      }
      this.audit(ctx.draft.guildId, draftId, 'config_changed', actor, `Configuration changed: ${keys.join(', ')}`, { keys }, beforeSubset, afterSubset);
      return { before: ctx.config, after };
    });
  }

  setChannel(draftId: number, channel: { channelId: string; kind: ChannelKind; parentChannelId: string | null } | null, actor: Actor): Draft {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      this.repos.drafts.setChannel(draftId, channel?.channelId ?? null, channel?.kind ?? null, channel?.parentChannelId ?? null);
      this.audit(
        ctx.draft.guildId,
        draftId,
        'channel_changed',
        actor,
        channel ? `Draft channel set to ${channel.kind} ${channel.channelId}` : 'Draft channel cleared',
        undefined,
        { channelId: ctx.draft.channelId, kind: ctx.draft.channelKind },
        channel,
      );
      return this.repos.drafts.getById(draftId) as Draft;
    });
  }

  setAdminRole(guildId: string, roleId: string | null, actor: Actor): void {
    this.tx(() => {
      const before = this.repos.drafts.getGuildSettings(guildId);
      this.repos.drafts.setAdminRole(guildId, roleId, this.clock.nowIso());
      this.audit(guildId, null, 'admin_role_changed', actor, roleId ? `Admin role set to ${roleId}` : 'Admin role cleared', undefined, { roleId: before?.adminRoleId ?? null }, { roleId });
    });
  }

  addParticipant(draftId: number, input: { label: string; discordUserId: string | null; actor: Actor }): ParticipantWithUsers {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['setup', 'randomized'], 'Adding a participant');
      const label = input.label.trim();
      if (!label) throw new DraftError('VALIDATION', 'A participant needs a label.');
      if (label.length > 60) throw new DraftError('VALIDATION', 'Participant labels must be 60 characters or fewer.');
      if (this.repos.participants.getByLabel(draftId, label)) {
        throw new DraftError('PARTICIPANT_EXISTS', `A participant called "${label}" already exists. Choose another label or add the user to that seat.`);
      }
      if (input.discordUserId) {
        const seats = this.repos.participants.listSeatsForUser(draftId, input.discordUserId);
        if (seats.length >= ctx.config.maxSeatsPerUser) {
          throw new DraftError(
            'PARTICIPANT_EXISTS',
            seats.length === 1
              ? `<@${input.discordUserId}> is already registered as "${seats[0]?.label}". Raise "seats per user" in the config to let one person control several seats.`
              : `<@${input.discordUserId}> already controls ${seats.length} seats, the configured maximum.`,
          );
        }
      }
      const now = this.clock.nowIso();
      const participant = this.repos.participants.create({ draftId, label, createdBy: input.actor.id, now });
      if (input.discordUserId) {
        this.repos.participants.addUser({ draftId, participantId: participant.id, discordUserId: input.discordUserId, role: 'owner', now });
      }
      this.invalidateOrder(ctx, input.actor);
      this.audit(ctx.draft.guildId, draftId, 'participant_added', input.actor, `Participant "${label}" added${input.discordUserId ? ` for <@${input.discordUserId}>` : ''}`, {
        participantId: participant.id,
        discordUserId: input.discordUserId,
      });
      return this.repos.participants.getWithUsers(participant.id) as ParticipantWithUsers;
    });
  }

  addUserToSeat(draftId: number, participantId: number, discordUserId: string, actor: Actor): ParticipantWithUsers {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['setup', 'randomized', 'active'], 'Adding a user to a seat');
      const seat = this.requireParticipant(ctx, participantId);
      if (this.repos.participants.isMember(participantId, discordUserId)) {
        throw new DraftError('PARTICIPANT_EXISTS', `<@${discordUserId}> is already on "${seat.label}".`);
      }
      const seats = this.repos.participants.listSeatsForUser(draftId, discordUserId);
      if (seats.length >= ctx.config.maxSeatsPerUser) {
        throw new DraftError('PARTICIPANT_EXISTS', `<@${discordUserId}> already controls the maximum number of seats (${ctx.config.maxSeatsPerUser}).`);
      }
      this.repos.participants.addUser({ draftId, participantId, discordUserId, role: 'manager', now: this.clock.nowIso() });
      this.audit(ctx.draft.guildId, draftId, 'participant_user_added', actor, `<@${discordUserId}> added to seat "${seat.label}"`, { participantId, discordUserId });
      return this.repos.participants.getWithUsers(participantId) as ParticipantWithUsers;
    });
  }

  removeUserFromSeat(draftId: number, participantId: number, discordUserId: string, actor: Actor): ParticipantWithUsers {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      const seat = this.requireParticipant(ctx, participantId);
      if (!this.repos.participants.isMember(participantId, discordUserId)) {
        throw new DraftError('PARTICIPANT_NOT_FOUND', `<@${discordUserId}> is not on "${seat.label}".`);
      }
      this.repos.participants.removeUser(participantId, discordUserId);
      this.audit(ctx.draft.guildId, draftId, 'participant_user_removed', actor, `<@${discordUserId}> removed from seat "${seat.label}"`, { participantId, discordUserId });
      return this.repos.participants.getWithUsers(participantId) as ParticipantWithUsers;
    });
  }

  removeParticipant(draftId: number, participantId: number, actor: Actor): void {
    this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['setup', 'randomized'], 'Removing a participant');
      const seat = this.requireParticipant(ctx, participantId);
      this.repos.participants.delete(participantId);
      this.invalidateOrder(ctx, actor);
      this.audit(ctx.draft.guildId, draftId, 'participant_removed', actor, `Participant "${seat.label}" removed`, { participantId, users: seat.users.map((u) => u.discordUserId) }, seat);
    });
  }

  addTeam(
    draftId: number,
    input: { teamNumber: string; teamName: string | null; organization: string | null; location: string | null; extra?: Record<string, string> | null },
    actor: Actor,
  ): Team {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['setup', 'randomized', 'active'], 'Adding a team');
      const teamNumber = normalizeTeamNumber(input.teamNumber);
      if (!isValidTeamNumber(teamNumber)) throw new DraftError('VALIDATION', `"${input.teamNumber}" is not a valid VEX team number.`);
      if (this.repos.teams.getByNumber(draftId, teamNumber)) {
        throw new DraftError('TEAM_EXISTS', `Team ${teamNumber} is already in this draft.`);
      }
      const team = this.repos.teams.create(draftId, { teamNumber, teamName: input.teamName, organization: input.organization, location: input.location, extra: input.extra ?? null }, this.clock.nowIso());
      this.audit(ctx.draft.guildId, draftId, 'team_added', actor, `Team ${teamNumber} added`, { teamId: team.id }, undefined, team);
      return team;
    });
  }

  randomize(draftId: number, actor: Actor): ParticipantWithUsers[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['setup', 'randomized'], 'Randomizing the order');
      const participants = this.repos.participants.listByDraft(draftId);
      if (participants.length < 2) throw new DraftError('VALIDATION', 'Add at least two participants before randomizing.');
      if (ctx.config.participantCount !== null && ctx.config.participantCount !== participants.length) {
        throw new DraftError(
          'INVALID_CONFIG',
          `The config expects ${ctx.config.participantCount} participants but ${participants.length} are registered. Adjust the participants or run /draft config participants.`,
        );
      }
      const shuffled = shuffle(participants, this.random);
      this.repos.participants.clearPositions(draftId);
      shuffled.forEach((p, i) => this.repos.participants.setPosition(p.id, i + 1));
      this.repos.drafts.setStatus(draftId, 'randomized', this.clock.nowIso());
      const ordered = this.repos.participants.listWithUsers(draftId);
      this.audit(ctx.draft.guildId, draftId, 'draft_randomized', actor, 'Draft order randomized', { order: ordered.map((p) => ({ id: p.id, label: p.label, position: p.draftPosition })) });
      return ordered;
    });
  }

  validateReadyToStart(draftId: number): StartValidation {
    const ctx = loadContext(this.repos, draftId);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (ctx.draft.status === 'active') errors.push('The draft has already started.');
    else if (ctx.draft.status !== 'randomized') errors.push('Run /draft randomize to set the draft order first.');
    errors.push(...validateConfig(ctx.config));
    const participants = this.repos.participants.listWithUsers(draftId);
    if (participants.length < 2) errors.push('At least two participants are required.');
    if (participants.some((p) => p.draftPosition === null)) errors.push('Some participants have no draft position. Run /draft randomize again.');
    if (ctx.config.participantCount !== null && ctx.config.participantCount !== participants.length) {
      errors.push(`The config expects ${ctx.config.participantCount} participants but ${participants.length} are registered.`);
    }
    const noUsers = participants.filter((p) => p.users.length === 0);
    if (noUsers.length > 0) warnings.push(`These seats have no Discord user and can only be picked for by admins or prepicks: ${noUsers.map((p) => p.label).join(', ')}.`);
    if (!ctx.draft.channelId) errors.push('Set the draft channel with /draft channel set first.');
    const teamCount = this.repos.teams.count(draftId);
    if (teamCount === 0) errors.push('Import or add teams before starting.');
    const total = participants.length * ctx.config.rounds * ctx.config.picksPerRound;
    const capacity = teamCount * ctx.config.maxInstancesPerTeam;
    if (teamCount > 0 && capacity < total) {
      warnings.push(`Only ${capacity} team instance(s) are available for ${total} picks. The draft will end early when the pool is empty.`);
    }
    if (!ctx.config.skipTimerSeconds) warnings.push('No skip timer is configured; admins must use /draft skip for absent players.');
    return { errors, warnings };
  }

  start(draftId: number, actor: Actor): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      if (ctx.draft.status === 'active') throw new DraftError('INVALID_STATE', 'The draft has already started.');
      const validation = this.validateReadyToStart(draftId);
      if (validation.errors.length > 0) {
        throw new DraftError('VALIDATION', `The draft cannot start yet:\n• ${validation.errors.join('\n• ')}`);
      }
      const participants = this.repos.participants.listWithUsers(draftId);
      const seatIdByIndex = participants.map((p) => p.id);
      const specs = generatePickOrder({
        participantCount: participants.length,
        rounds: ctx.config.rounds,
        picksPerRound: ctx.config.picksPerRound,
        snake: ctx.config.snakeOrder,
      });
      const now = this.clock.nowIso();
      const slots = this.repos.slots.createMany(draftId, specs, seatIdByIndex);
      for (const slot of slots) {
        this.repos.assets.createPickAsset({ draftId, pickSlotId: slot.id, participantId: slot.originalParticipantId, now });
      }
      // Lock the participant count to what was materialized.
      this.repos.drafts.saveConfig(draftId, { ...ctx.config, participantCount: participants.length }, now);
      this.repos.drafts.setStatus(draftId, 'active', now);
      this.audit(ctx.draft.guildId, draftId, 'draft_started', actor, `Draft started with ${participants.length} participants and ${slots.length} picks`, {
        totalPicks: slots.length,
        order: participants.map((p) => ({ id: p.id, label: p.label })),
      });
      const events: DraftEvent[] = [{ type: 'draft_started', draftId, order: participants, totalPicks: slots.length }];
      const fresh = loadContext(this.repos, draftId);
      this.advance(fresh, 0, events, actor);
      return events;
    });
  }

  // ---------------------------------------------------------------------------
  // Picks and turns
  // ---------------------------------------------------------------------------

  /**
   * A participant (or an admin on their behalf) picks a team. If it is the seat's turn
   * the current slot is used; otherwise, when the after-skip policy allows it, the seat's
   * earliest open skipped slot is filled instead.
   */
  pick(draftId: number, input: { participantId: number; teamId: number; actor: Actor; kind?: PickKind }): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active'], 'Picking');
      const participant = this.requireParticipant(ctx, input.participantId);
      if (input.actor.kind === 'user' && !this.repos.participants.isMember(participant.id, input.actor.id)) {
        throw new DraftError('PERMISSION_DENIED', `You are not a member of "${participant.label}".`);
      }
      const events: DraftEvent[] = [];
      const current = ctx.draft.currentSlotId ? this.repos.slots.getById(ctx.draft.currentSlotId) : null;
      const currentOwner = current ? this.slotOwnerId(current) : null;
      if (current && currentOwner === participant.id) {
        const kind: PickKind = input.kind ?? 'pick';
        this.executePick(ctx, { slot: current, participant, teamId: input.teamId, kind, actor: input.actor }, events);
        this.advance(loadContext(this.repos, draftId), current.overallPick, events, input.actor);
        return events;
      }
      // Not their turn: maybe a catch-up pick.
      const skipped = this.openSkippedSlotsFor(ctx, participant.id);
      if (ctx.config.afterSkipPolicy === 'catch_up' && skipped.length > 0) {
        const slot = skipped[0] as PickSlot;
        this.executePick(ctx, { slot, participant, teamId: input.teamId, kind: input.kind === 'forced' ? 'forced' : 'catch_up', actor: input.actor }, events);
        return events;
      }
      if (!current) throw new DraftError('NOT_YOUR_TURN', 'There is no active pick right now.');
      const owner = this.repos.participants.getWithUsers(currentOwner as number);
      throw new DraftError('NOT_YOUR_TURN', `You can't pick right now. It is ${mentionSeat(owner)}'s turn.`, { currentOwnerId: currentOwner });
    });
  }

  /** Admin: skip whoever is on the clock. */
  skipCurrent(draftId: number, actor: Actor, reason: 'admin' | 'timer' = 'admin'): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active'], 'Skipping');
      const current = ctx.draft.currentSlotId ? this.repos.slots.getById(ctx.draft.currentSlotId) : null;
      if (!current) throw new DraftError('INVALID_STATE', 'There is no active pick to skip.');
      const events: DraftEvent[] = [];
      this.skipSlot(ctx, current, reason, actor, events);
      this.advance(loadContext(this.repos, draftId), current.overallPick, events, actor);
      return events;
    });
  }

  /**
   * Timer callback. Idempotent: if the token no longer matches the current turn (the
   * turn already resolved) nothing happens.
   */
  expireTurn(draftId: number, token: string): DraftEvent[] {
    return this.tx(() => {
      const draft = this.repos.drafts.getById(draftId);
      if (!draft || draft.status !== 'active') return [];
      if (!draft.turnToken || draft.turnToken !== token) return [];
      if (!draft.turnDeadlineAt || Date.parse(draft.turnDeadlineAt) > this.clock.nowMs()) return [];
      const ctx = loadContext(this.repos, draftId);
      const current = ctx.draft.currentSlotId ? this.repos.slots.getById(ctx.draft.currentSlotId) : null;
      if (!current || current.status !== 'current') return [];
      const events: DraftEvent[] = [];
      if (ctx.config.allowPrepicks && ctx.config.prepickMode === 'on_timeout' && this.applyPrepick(ctx, current, events)) {
        this.advance(loadContext(this.repos, draftId), current.overallPick, events, SYSTEM_ACTOR);
        return events;
      }
      this.skipSlot(ctx, current, 'timer', SYSTEM_ACTOR, events);
      this.advance(loadContext(this.repos, draftId), current.overallPick, events, SYSTEM_ACTOR);
      return events;
    });
  }

  /** Admin: end the draft now, forfeiting whatever remains. */
  complete(draftId: number, actor: Actor): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active'], 'Completing the draft');
      const events: DraftEvent[] = [];
      this.finish(ctx, 'admin', events, actor);
      return events;
    });
  }

  // ---------------------------------------------------------------------------
  // Admin roster management
  // ---------------------------------------------------------------------------

  adminAddTeam(draftId: number, participantId: number, teamId: number, actor: Actor): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active', 'completed'], 'Editing rosters');
      const participant = this.requireParticipant(ctx, participantId);
      const team = this.requireAvailableTeam(ctx, teamId);
      const now = this.clock.nowIso();
      const asset = this.repos.assets.createTeamAsset({
        draftId,
        teamId: team.id,
        instanceNo: this.nextInstanceNo(team.id),
        pickSlotId: null,
        participantId,
        acquiredVia: 'admin',
        now,
      });
      const pick = this.repos.picks.create({ draftId, pickSlotId: null, overallPick: null, round: null, participantId, teamId: team.id, assetId: asset.id, kind: 'admin_add', madeBy: actor.id, now });
      this.repos.prepicks.removeByTeam(draftId, team.id);
      this.audit(ctx.draft.guildId, draftId, 'roster_team_added', actor, `Admin added team ${team.teamNumber} to "${participant.label}"`, { participantId, teamId, assetId: asset.id });
      return [
        { type: 'pick_made', draftId, pick, team, participant, slot: null, kind: 'admin_add', actorId: actor.id },
        { type: 'roster_changed', draftId, summary: `${team.teamNumber} added to ${mentionSeat(participant)} by an admin`, actorId: actor.id },
      ];
    });
  }

  /** Replace the team on an existing roster entry, preserving pick number and round. */
  adminReplaceTeam(draftId: number, target: { participantId: number; oldTeamId: number } | { overallPick: number }, newTeamId: number, actor: Actor): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active', 'completed'], 'Editing rosters');
      let asset;
      if ('overallPick' in target) {
        const slot = this.repos.slots.getByOverall(draftId, target.overallPick);
        if (!slot) throw new DraftError('PICK_NOT_FOUND', `There is no pick #${target.overallPick}.`);
        asset = this.repos.assets.getTeamAssetForSlot(slot.id);
        if (!asset) throw new DraftError('PICK_NOT_FOUND', `Pick #${target.overallPick} has no team on a roster to correct.`);
      } else {
        asset = this.repos.assets.findActiveTeamAsset(target.participantId, target.oldTeamId);
        if (!asset) {
          const p = this.requireParticipant(ctx, target.participantId);
          const t = this.repos.teams.getById(target.oldTeamId);
          throw new DraftError('ASSET_NOT_FOUND', `${t ? `Team ${t.teamNumber}` : 'That team'} is not on "${p.label}"'s roster.`);
        }
      }
      const oldTeam = this.repos.teams.getById(asset.teamId as number) as Team;
      if (oldTeam.id === newTeamId) throw new DraftError('VALIDATION', 'The replacement team is the same team.');
      const newTeam = this.requireAvailableTeam(ctx, newTeamId);
      const participant = this.repos.participants.getWithUsers(asset.currentParticipantId) as ParticipantWithUsers;
      const slot = asset.pickSlotId ? this.repos.slots.getById(asset.pickSlotId) : null;
      const now = this.clock.nowIso();
      this.repos.assets.setTeam(asset.id, newTeam.id, this.nextInstanceNo(newTeam.id), now);
      const oldPick = this.repos.picks.getActiveForAsset(asset.id);
      if (oldPick) this.repos.picks.void(oldPick.id, actor.id, `corrected to ${newTeam.teamNumber}`, now);
      this.repos.picks.create({
        draftId,
        pickSlotId: slot?.id ?? null,
        overallPick: slot?.overallPick ?? null,
        round: slot?.round ?? null,
        participantId: participant.id,
        teamId: newTeam.id,
        assetId: asset.id,
        kind: 'correction',
        madeBy: actor.id,
        now,
      });
      this.repos.prepicks.removeByTeam(draftId, newTeam.id);
      this.audit(
        ctx.draft.guildId,
        draftId,
        'pick_corrected',
        actor,
        `Pick ${slot ? `#${slot.overallPick}` : '(admin-added)'} for "${participant.label}" corrected from ${oldTeam.teamNumber} to ${newTeam.teamNumber}`,
        { assetId: asset.id, participantId: participant.id, slotId: slot?.id ?? null },
        { teamId: oldTeam.id, teamNumber: oldTeam.teamNumber },
        { teamId: newTeam.id, teamNumber: newTeam.teamNumber },
      );
      return [{ type: 'pick_corrected', draftId, participant, oldTeam, newTeam, slot, actorId: actor.id }];
    });
  }

  adminDropTeam(draftId: number, participantId: number, teamId: number, opts: { removeFromPool: boolean }, actor: Actor): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active', 'completed'], 'Editing rosters');
      const participant = this.requireParticipant(ctx, participantId);
      const team = this.requireTeam(ctx, teamId);
      const asset = this.repos.assets.findActiveTeamAsset(participantId, teamId);
      if (!asset) throw new DraftError('ASSET_NOT_FOUND', `Team ${team.teamNumber} is not on "${participant.label}"'s roster.`);
      this.cancelOpenTradesForAssets(ctx, [asset.id], `team ${team.teamNumber} was dropped by an admin`, actor);
      const now = this.clock.nowIso();
      this.repos.assets.setStatus(asset.id, opts.removeFromPool ? 'removed' : 'dropped', now);
      if (opts.removeFromPool) this.repos.teams.setRemoved(team.id, now, now);
      this.audit(
        ctx.draft.guildId,
        draftId,
        'roster_team_dropped',
        actor,
        `Admin dropped team ${team.teamNumber} from "${participant.label}"${opts.removeFromPool ? ' and removed it from the pool' : ' (returned to pool)'}`,
        { participantId, teamId, assetId: asset.id, removeFromPool: opts.removeFromPool },
        asset,
      );
      return [
        {
          type: 'roster_changed',
          draftId,
          summary: `${team.teamNumber} dropped from ${mentionSeat(participant)} by an admin${opts.removeFromPool ? ' and removed from the pool' : ' and returned to the pool'}`,
          actorId: actor.id,
        },
      ];
    });
  }

  adminMoveTeam(draftId: number, fromParticipantId: number, toParticipantId: number, teamId: number, actor: Actor): DraftEvent[] {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active', 'completed'], 'Editing rosters');
      if (fromParticipantId === toParticipantId) throw new DraftError('VALIDATION', 'Source and destination are the same participant.');
      const from = this.requireParticipant(ctx, fromParticipantId);
      const to = this.requireParticipant(ctx, toParticipantId);
      const team = this.requireTeam(ctx, teamId);
      const asset = this.repos.assets.findActiveTeamAsset(fromParticipantId, teamId);
      if (!asset) throw new DraftError('ASSET_NOT_FOUND', `Team ${team.teamNumber} is not on "${from.label}"'s roster.`);
      this.assertRosterCapacity(ctx, to, 1);
      this.cancelOpenTradesForAssets(ctx, [asset.id], `team ${team.teamNumber} was moved by an admin`, actor);
      const now = this.clock.nowIso();
      this.repos.assets.setOwner(asset.id, toParticipantId, 'admin', now);
      this.repos.assets.recordTransfer({ draftId, assetId: asset.id, from: fromParticipantId, to: toParticipantId, reason: 'admin_move', tradeId: null, actor: actor.id, now });
      this.audit(ctx.draft.guildId, draftId, 'roster_team_moved', actor, `Admin moved team ${team.teamNumber} from "${from.label}" to "${to.label}"`, { assetId: asset.id, teamId }, { participantId: fromParticipantId }, { participantId: toParticipantId });
      return [{ type: 'roster_changed', draftId, summary: `${team.teamNumber} moved from ${mentionSeat(from)} to ${mentionSeat(to)} by an admin`, actorId: actor.id }];
    });
  }

  removeTeam(draftId: number, teamId: number, opts: { force: boolean }, actor: Actor): { team: Team; droppedFrom: ParticipantWithUsers[]; prepicksRemoved: number } {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      const team = this.requireTeam(ctx, teamId);
      if (team.removedAt) throw new DraftError('TEAM_REMOVED', `Team ${team.teamNumber} is already removed.`);
      const active = this.repos.assets.listActiveForTeam(teamId);
      const owners = active.map((a) => this.repos.participants.getWithUsers(a.currentParticipantId) as ParticipantWithUsers);
      if (active.length > 0 && !opts.force) {
        throw new DraftError(
          'VALIDATION',
          `Team ${team.teamNumber} is on a roster (${owners.map((o) => o.label).join(', ')}). Re-run with force:true to drop it from those rosters as well.`,
        );
      }
      const now = this.clock.nowIso();
      this.cancelOpenTradesForAssets(ctx, active.map((a) => a.id), `team ${team.teamNumber} was removed from the draft`, actor);
      for (const a of active) this.repos.assets.setStatus(a.id, 'removed', now);
      const prepicksRemoved = this.repos.prepicks.removeByTeam(draftId, teamId);
      this.repos.teams.setRemoved(teamId, now, now);
      this.audit(ctx.draft.guildId, draftId, 'team_removed', actor, `Team ${team.teamNumber} removed from the draft${active.length ? ` (dropped from ${owners.map((o) => o.label).join(', ')})` : ''}`, {
        teamId,
        droppedAssetIds: active.map((a) => a.id),
        prepicksRemoved,
      });
      return { team, droppedFrom: owners, prepicksRemoved };
    });
  }

  restoreTeam(draftId: number, teamId: number, actor: Actor): Team {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      const team = this.requireTeam(ctx, teamId);
      if (!team.removedAt) throw new DraftError('VALIDATION', `Team ${team.teamNumber} is not removed.`);
      const now = this.clock.nowIso();
      this.repos.teams.setRemoved(teamId, null, now);
      this.audit(ctx.draft.guildId, draftId, 'team_restored', actor, `Team ${team.teamNumber} returned to the pool`, { teamId });
      return this.repos.teams.getById(teamId) as Team;
    });
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Wipes the active draft. With `purge` the rows are deleted (audit events are kept
   * because they do not reference the draft by foreign key); otherwise the draft is
   * archived in place and all of its history remains queryable.
   */
  reset(draftId: number, actor: Actor, opts: { purge: boolean }): { draft: Draft; purged: boolean } {
    return this.tx(() => {
      const ctx = loadContext(this.repos, draftId);
      if (ctx.draft.status === 'archived') throw new DraftError('INVALID_STATE', 'This draft was already reset.');
      const now = this.clock.nowIso();
      const stats = {
        participants: this.repos.participants.listByDraft(draftId).length,
        teams: this.repos.teams.count(draftId),
        picks: this.repos.picks.listByDraft(draftId).length,
        slots: this.repos.slots.countByStatus(draftId),
      };
      for (const trade of this.repos.trades.listOpen(draftId)) {
        this.repos.trades.setStatus(trade.id, 'cancelled', { resolvedAt: now, resolvedBy: actor.id, resolutionNote: 'draft reset' });
      }
      this.audit(ctx.draft.guildId, draftId, 'draft_reset', actor, `Draft "${ctx.draft.name}" reset${opts.purge ? ' and purged' : ' (archived)'}`, { purge: opts.purge }, { status: ctx.draft.status, ...stats });
      if (opts.purge) {
        this.repos.drafts.delete(draftId);
        return { draft: { ...ctx.draft, status: 'archived', archivedAt: now }, purged: true };
      }
      this.repos.drafts.setTurn(draftId, { currentSlotId: null, turnToken: null, turnStartedAt: null, turnDeadlineAt: null });
      this.repos.drafts.setStatus(draftId, 'archived', now);
      return { draft: this.repos.drafts.getById(draftId) as Draft, purged: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  getState(draftId: number): DraftStateView {
    const ctx = loadContext(this.repos, draftId);
    const participants = this.repos.participants.listWithUsers(draftId);
    const byId = new Map(participants.map((p) => [p.id, p]));
    const currentSlot = ctx.draft.currentSlotId ? this.repos.slots.getById(ctx.draft.currentSlotId) : null;
    const currentOwnerId = currentSlot ? this.slotOwnerId(currentSlot) : null;
    const currentOwner = currentOwnerId ? (byId.get(currentOwnerId) ?? null) : null;
    const counts = this.repos.slots.countByStatus(draftId);
    const totalSlots = this.repos.slots.count(draftId);
    const resolvedSlots = counts.picked + counts.forfeited + counts.void;
    const recent = this.repos.picks.listRecent(draftId, 5).map((pick) => ({
      pick,
      team: this.repos.teams.getById(pick.teamId) as Team,
      participant: byId.get(pick.participantId) as ParticipantWithUsers,
    }));
    const upcoming: Array<{ slot: PickSlot; owner: ParticipantWithUsers }> = [];
    if (currentSlot) {
      let cursor = currentSlot.overallPick;
      for (let i = 0; i < 5; i++) {
        const next = this.repos.slots.nextPending(draftId, cursor);
        if (!next) break;
        const owner = byId.get(this.slotOwnerId(next));
        if (owner) upcoming.push({ slot: next, owner });
        cursor = next.overallPick;
      }
    }
    const openSkipped = this.repos.slots
      .listByStatus(draftId, 'skipped')
      .map((slot) => ({ slot, owner: byId.get(this.slotOwnerId(slot)) as ParticipantWithUsers }))
      .filter((x) => x.owner);
    return {
      draft: ctx.draft,
      config: ctx.config,
      participants,
      currentSlot,
      currentOwner,
      totalSlots,
      resolvedSlots,
      availableTeams: this.repos.teams.countAvailable(draftId, ctx.config.maxInstancesPerTeam),
      totalTeams: this.repos.teams.count(draftId),
      recentPicks: recent,
      upcoming,
      currentOwnerRosterCount: currentOwner ? this.repos.assets.countActiveTeamAssets(currentOwner.id) : 0,
      openSkippedSlots: openSkipped,
    };
  }

  getRoster(draftId: number, participantId: number): RosterView {
    const ctx = loadContext(this.repos, draftId);
    const participant = this.requireParticipant(ctx, participantId);
    const seats = new Map<number, ParticipantWithUsers>();
    const seat = (id: number): ParticipantWithUsers | null => {
      if (!seats.has(id)) {
        const p = this.repos.participants.getWithUsers(id);
        if (p) seats.set(id, p);
      }
      return seats.get(id) ?? null;
    };
    const teams = this.repos.assets.listRoster(participantId).map((asset) => ({
      assetId: asset.id,
      team: this.repos.teams.getById(asset.teamId as number) as Team,
      overallPick: asset.overallPick,
      round: asset.round,
      acquiredVia: asset.acquiredVia,
      originalOwner: asset.originalParticipantId === participantId ? null : seat(asset.originalParticipantId),
      transfers: this.repos.assets.listTransfers(asset.id).map((t) => ({
        from: seat(t.fromParticipantId),
        to: seat(t.toParticipantId),
        reason: t.reason,
        tradeId: t.tradeId,
        at: t.createdAt,
      })),
    }));
    const futurePicks = this.repos.assets
      .listFuturePicks(participantId)
      .filter((a) => a.slotStatus === 'pending' || a.slotStatus === 'current' || a.slotStatus === 'skipped')
      .map((a) => ({
        assetId: a.id,
        overallPick: a.overallPick,
        round: a.round,
        originalOwner: a.originalParticipantId === participantId ? null : seat(a.originalParticipantId),
        slotStatus: a.slotStatus,
      }));
    return { participant, teams, futurePicks, totalPicks: teams.length, maxRoster: ctx.config.maxRosterSize };
  }

  getTeamInfo(draftId: number, teamId: number): TeamInfoView {
    const ctx = loadContext(this.repos, draftId);
    const team = this.requireTeam(ctx, teamId);
    const owners = this.repos.assets.listActiveForTeam(teamId).map((asset) => ({
      participant: this.repos.participants.getWithUsers(asset.currentParticipantId) as ParticipantWithUsers,
      overallPick: asset.overallPick,
      round: asset.round,
      viaTrade: asset.acquiredVia === 'trade',
      originalOwner: asset.originalParticipantId === asset.currentParticipantId ? null : this.repos.participants.getWithUsers(asset.originalParticipantId),
      acquiredVia: asset.acquiredVia,
    }));
    return {
      team,
      removed: team.removedAt !== null,
      available: team.removedAt === null && owners.length < ctx.config.maxInstancesPerTeam,
      instancesUsed: owners.length,
      maxInstances: ctx.config.maxInstancesPerTeam,
      owners,
    };
  }

  getOrder(draftId: number): Array<{ slot: PickSlot; originalOwner: ParticipantWithUsers; currentOwner: ParticipantWithUsers; team: Team | null }> {
    const participants = new Map(this.repos.participants.listWithUsers(draftId).map((p) => [p.id, p]));
    return this.repos.slots.listByDraft(draftId).map((slot) => {
      const teamAsset = this.repos.assets.getTeamAssetForSlot(slot.id);
      return {
        slot,
        originalOwner: participants.get(slot.originalParticipantId) as ParticipantWithUsers,
        currentOwner: participants.get(this.slotOwnerId(slot)) as ParticipantWithUsers,
        team: teamAsset ? this.repos.teams.getById(teamAsset.teamId as number) : null,
      };
    });
  }

  /** The seat currently on the clock (if any) and who owns it. */
  currentTurn(draftId: number): { slot: PickSlot; owner: ParticipantWithUsers } | null {
    const draft = this.repos.drafts.getById(draftId);
    if (!draft?.currentSlotId) return null;
    const slot = this.repos.slots.getById(draft.currentSlotId);
    if (!slot) return null;
    const owner = this.repos.participants.getWithUsers(this.slotOwnerId(slot));
    return owner ? { slot, owner } : null;
  }

  /** Seats owned by the user that currently have an open skipped slot they may fill. */
  catchUpSeatsForUser(draftId: number, discordUserId: string): ParticipantWithUsers[] {
    const ctx = loadContext(this.repos, draftId);
    if (ctx.config.afterSkipPolicy !== 'catch_up') return [];
    return this.repos.participants
      .listSeatsForUser(draftId, discordUserId)
      .filter((p) => this.openSkippedSlotsFor(ctx, p.id).length > 0)
      .map((p) => this.repos.participants.getWithUsers(p.id) as ParticipantWithUsers);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private tx<T>(fn: () => T): T {
    return inTransaction(this.repos.db, fn);
  }

  private audit(guildId: string | null, draftId: number | null, eventType: string, actor: Actor, summary: string, subject?: unknown, before?: unknown, after?: unknown): void {
    this.repos.audit.record({ guildId, draftId, eventType, actor, summary, subject, before, after, now: this.clock.nowIso() });
  }

  private requireParticipant(ctx: DraftContext, participantId: number): ParticipantWithUsers {
    const p = this.repos.participants.getWithUsers(participantId);
    if (!p || p.draftId !== ctx.draft.id) throw new DraftError('PARTICIPANT_NOT_FOUND', 'That participant is not part of this draft.');
    return p;
  }

  private requireTeam(ctx: DraftContext, teamId: number): Team {
    const t = this.repos.teams.getById(teamId);
    if (!t || t.draftId !== ctx.draft.id) throw new DraftError('TEAM_NOT_FOUND', 'That team is not in this draft.');
    return t;
  }

  private requireAvailableTeam(ctx: DraftContext, teamId: number): Team {
    const team = this.requireTeam(ctx, teamId);
    if (team.removedAt) throw new DraftError('TEAM_REMOVED', `Team ${team.teamNumber} has been removed from this draft.`);
    const used = this.repos.assets.listActiveForTeam(teamId);
    if (used.length >= ctx.config.maxInstancesPerTeam) {
      const first = used[0];
      const owner = first ? this.repos.participants.getWithUsers(first.currentParticipantId) : null;
      const where = first?.overallPick ? ` at overall pick #${first.overallPick}` : '';
      throw new DraftError(
        'TEAM_UNAVAILABLE',
        used.length === 1 && owner
          ? `Team ${team.teamNumber} is no longer available. It was selected by ${mentionSeat(owner)}${where}.`
          : `Team ${team.teamNumber} is no longer available (all ${ctx.config.maxInstancesPerTeam} copies are taken).`,
        { teamId, ownerIds: used.map((u) => u.currentParticipantId) },
      );
    }
    return team;
  }

  private nextInstanceNo(teamId: number): number {
    const used = new Set(this.repos.assets.usedInstanceNumbers(teamId));
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  }

  private slotOwnerId(slot: PickSlot): number {
    const asset = this.repos.assets.getPickAssetForSlot(slot.id);
    return asset ? asset.currentParticipantId : slot.originalParticipantId;
  }

  private openSkippedSlotsFor(ctx: DraftContext, participantId: number): PickSlot[] {
    return this.repos.slots.listByStatus(ctx.draft.id, 'skipped').filter((s) => this.slotOwnerId(s) === participantId);
  }

  private assertRosterCapacity(ctx: DraftContext, participant: Participant, adding: number): void {
    if (ctx.config.maxRosterSize === null) return;
    const teams = this.repos.assets.countActiveTeamAssets(participant.id);
    const pending = this.repos.assets.countPendingPickAssets(participant.id);
    if (teams + pending + adding > ctx.config.maxRosterSize) {
      throw new DraftError('VALIDATION', `"${participant.label}" would exceed the maximum roster size of ${ctx.config.maxRosterSize} (teams plus remaining picks).`);
    }
  }

  private invalidateOrder(ctx: DraftContext, actor: Actor): void {
    if (ctx.draft.status === 'randomized') {
      this.repos.participants.clearPositions(ctx.draft.id);
      this.repos.drafts.setStatus(ctx.draft.id, 'setup', this.clock.nowIso());
      this.audit(ctx.draft.guildId, ctx.draft.id, 'order_invalidated', actor, 'Participants changed; the randomized order was cleared');
    }
  }

  private cancelOpenTradesForAssets(ctx: DraftContext, assetIds: number[], reason: string, actor: Actor): void {
    const now = this.clock.nowIso();
    for (const trade of this.repos.trades.openTradesForAssets(ctx.draft.id, assetIds)) {
      this.repos.trades.setStatus(trade.id, 'cancelled', { resolvedAt: now, resolvedBy: actor.id, resolutionNote: reason });
      this.audit(ctx.draft.guildId, ctx.draft.id, 'trade_cancelled', actor, `Trade #${trade.id} cancelled: ${reason}`, { tradeId: trade.id });
    }
  }

  /** Core pick execution shared by user picks, prepicks, forced and catch-up picks. */
  private executePick(
    ctx: DraftContext,
    input: { slot: PickSlot; participant: ParticipantWithUsers; teamId: number; kind: PickKind; actor: Actor },
    events: DraftEvent[],
  ): DraftPick {
    const { slot, participant } = input;
    const pickAsset = this.repos.assets.getPickAssetForSlot(slot.id);
    if (!pickAsset || pickAsset.status !== 'active' || pickAsset.currentParticipantId !== participant.id) {
      throw new DraftError('NOT_YOUR_TURN', `Pick #${slot.overallPick} does not belong to "${participant.label}".`);
    }
    if (slot.status !== 'current' && slot.status !== 'skipped') {
      throw new DraftError('INVALID_STATE', `Pick #${slot.overallPick} is not open.`);
    }
    const team = this.requireAvailableTeam(ctx, input.teamId);
    this.assertRosterCapacity(ctx, participant, 0);
    const now = this.clock.nowIso();
    const teamAsset = this.repos.assets.createTeamAsset({
      draftId: ctx.draft.id,
      teamId: team.id,
      instanceNo: this.nextInstanceNo(team.id),
      pickSlotId: slot.id,
      participantId: participant.id,
      acquiredVia: 'pick',
      now,
    });
    this.repos.assets.setStatus(pickAsset.id, 'consumed', now);
    this.repos.slots.setStatus(slot.id, 'picked');
    const pick = this.repos.picks.create({
      draftId: ctx.draft.id,
      pickSlotId: slot.id,
      overallPick: slot.overallPick,
      round: slot.round,
      participantId: participant.id,
      teamId: team.id,
      assetId: teamAsset.id,
      kind: input.kind,
      madeBy: input.actor.id,
      now,
    });
    const existingPrepick = this.repos.prepicks.find(participant.id, team.id);
    if (existingPrepick) this.repos.prepicks.remove(existingPrepick.id);
    this.audit(
      ctx.draft.guildId,
      ctx.draft.id,
      input.kind === 'prepick' ? 'prepick_applied' : input.kind === 'forced' ? 'pick_forced' : input.kind === 'catch_up' ? 'pick_catch_up' : 'pick_made',
      input.actor,
      `Pick #${slot.overallPick} (round ${slot.round}): "${participant.label}" selected ${team.teamNumber}${input.kind !== 'pick' ? ` [${input.kind}]` : ''}`,
      { slotId: slot.id, overallPick: slot.overallPick, participantId: participant.id, teamId: team.id, assetId: teamAsset.id },
    );
    events.push({ type: 'pick_made', draftId: ctx.draft.id, pick, team, participant, slot: { ...slot, status: 'picked' }, kind: input.kind, actorId: input.actor.id });
    return pick;
  }

  private skipSlot(ctx: DraftContext, slot: PickSlot, reason: 'admin' | 'timer', actor: Actor, events: DraftEvent[]): void {
    const ownerId = this.slotOwnerId(slot);
    const owner = this.repos.participants.getWithUsers(ownerId) as ParticipantWithUsers;
    const now = this.clock.nowIso();
    const catchUp = ctx.config.afterSkipPolicy === 'catch_up';
    this.repos.slots.setStatus(slot.id, catchUp ? 'skipped' : 'forfeited', now);
    if (!catchUp) {
      const asset = this.repos.assets.getPickAssetForSlot(slot.id);
      if (asset) this.repos.assets.setStatus(asset.id, 'void', now);
    }
    this.audit(ctx.draft.guildId, ctx.draft.id, 'pick_skipped', actor, `Pick #${slot.overallPick} (round ${slot.round}): "${owner.label}" skipped (${reason})${catchUp ? ', may pick later' : ', forfeited'}`, {
      slotId: slot.id,
      overallPick: slot.overallPick,
      participantId: ownerId,
      reason,
    });
    events.push({ type: 'turn_skipped', draftId: ctx.draft.id, participant: owner, slot, reason, catchUpAllowed: catchUp, actorId: actor.id });
  }

  /** Tries to auto-pick for the slot owner from their prepick list. Returns true on success. */
  private applyPrepick(ctx: DraftContext, slot: PickSlot, events: DraftEvent[]): boolean {
    if (!ctx.config.allowPrepicks) return false;
    const ownerId = this.slotOwnerId(slot);
    const owner = this.repos.participants.getWithUsers(ownerId) as ParticipantWithUsers;
    for (const prepick of this.repos.prepicks.list(ownerId)) {
      const team = this.repos.teams.getById(prepick.teamId);
      const available = team && !team.removedAt && this.repos.assets.listActiveForTeam(team.id).length < ctx.config.maxInstancesPerTeam;
      if (!team || !available) {
        this.repos.prepicks.remove(prepick.id);
        if (team) {
          this.audit(ctx.draft.guildId, ctx.draft.id, 'prepick_removed', SYSTEM_ACTOR, `Prepick ${team.teamNumber} dropped for "${owner.label}": no longer available`, { participantId: ownerId, teamId: team.id });
          events.push({ type: 'prepick_dropped', draftId: ctx.draft.id, participant: owner, team, reason: team.removedAt ? 'removed from the draft' : 'already taken' });
        }
        continue;
      }
      try {
        this.executePick(ctx, { slot, participant: owner, teamId: team.id, kind: 'prepick', actor: SYSTEM_ACTOR }, events);
      } catch (err) {
        if (err instanceof DraftError && (err.code === 'TEAM_UNAVAILABLE' || err.code === 'TEAM_REMOVED' || err.code === 'VALIDATION')) {
          this.repos.prepicks.remove(prepick.id);
          events.push({ type: 'prepick_dropped', draftId: ctx.draft.id, participant: owner, team, reason: err.message });
          continue;
        }
        throw err;
      }
      return true;
    }
    return false;
  }

  /**
   * Moves the draft to the next pending slot after `afterOverall`, applying immediate
   * prepicks in a loop, and completes the draft when nothing is left.
   */
  private advance(ctx: DraftContext, afterOverall: number, events: DraftEvent[], actor: Actor): void {
    let cursor = afterOverall;
    for (;;) {
      const next = this.repos.slots.nextPending(ctx.draft.id, cursor);
      if (!next) {
        this.finish(ctx, 'all_slots', events, actor);
        return;
      }
      if (this.repos.teams.countAvailable(ctx.draft.id, ctx.config.maxInstancesPerTeam) === 0) {
        this.finish(ctx, 'pool_empty', events, actor);
        return;
      }
      const current = this.beginSlot(ctx, next, events);
      if (ctx.config.allowPrepicks && ctx.config.prepickMode === 'immediate' && this.applyPrepick(ctx, current, events)) {
        cursor = next.overallPick;
        continue;
      }
      return;
    }
  }

  private beginSlot(ctx: DraftContext, slot: PickSlot, events: DraftEvent[]): PickSlot {
    const now = this.clock.nowIso();
    const ownerId = this.slotOwnerId(slot);
    const owner = this.repos.participants.getWithUsers(ownerId) as ParticipantWithUsers;
    const deadline = this.deadlineFor(ctx.config, now);
    this.repos.slots.setStatus(slot.id, 'current');
    this.repos.drafts.setTurn(ctx.draft.id, { currentSlotId: slot.id, turnToken: this.random.uuid(), turnStartedAt: now, turnDeadlineAt: deadline });
    const group = this.repos.slots.listByDraft(ctx.draft.id).filter((s) => s.round === slot.round && s.turnInRound === slot.turnInRound && this.slotOwnerId(s) === ownerId);
    const picksThisTurn = group.length;
    const pickIndexInTurn = group.filter((s) => s.overallPick <= slot.overallPick).length;
    this.audit(ctx.draft.guildId, ctx.draft.id, 'turn_started', SYSTEM_ACTOR, `Pick #${slot.overallPick} (round ${slot.round}): "${owner.label}" is on the clock${deadline ? ` until ${deadline}` : ''}`, {
      slotId: slot.id,
      participantId: ownerId,
      deadline,
    });
    const current: PickSlot = { ...slot, status: 'current' };
    events.push({ type: 'turn_started', draftId: ctx.draft.id, participant: owner, slot: current, deadline, pickIndexInTurn, picksThisTurn, totalPicks: this.repos.slots.count(ctx.draft.id) });
    return current;
  }

  private deadlineFor(config: DraftConfig, nowIso: string): string | null {
    if (!config.skipTimerSeconds || config.skipTimerSeconds <= 0) return null;
    const window: ActiveWindow | null =
      config.skipHoursStart && config.skipHoursEnd ? { start: config.skipHoursStart, end: config.skipHoursEnd, timezone: config.timezone } : null;
    return computeDeadline(nowIso, config.skipTimerSeconds, window);
  }

  private finish(ctx: DraftContext, reason: 'all_slots' | 'pool_empty' | 'admin', events: DraftEvent[], actor: Actor): void {
    const now = this.clock.nowIso();
    const forfeited: PickSlot[] = [];
    for (const slot of this.repos.slots.listByDraft(ctx.draft.id)) {
      if (slot.status === 'skipped' || slot.status === 'current' || slot.status === 'pending') {
        const asset = this.repos.assets.getPickAssetForSlot(slot.id);
        if (asset && asset.status === 'active') this.repos.assets.setStatus(asset.id, 'void', now);
        this.repos.slots.setStatus(slot.id, slot.status === 'pending' ? 'void' : 'forfeited');
        if (slot.status !== 'pending') forfeited.push(slot);
      }
    }
    this.repos.drafts.setTurn(ctx.draft.id, { currentSlotId: null, turnToken: null, turnStartedAt: null, turnDeadlineAt: null });
    this.repos.drafts.setStatus(ctx.draft.id, 'completed', now);
    this.audit(ctx.draft.guildId, ctx.draft.id, 'draft_completed', actor, `Draft completed (${reason === 'all_slots' ? 'all picks made' : reason === 'pool_empty' ? 'no teams left' : 'ended by admin'})`, {
      reason,
      forfeitedSlots: forfeited.map((s) => s.overallPick),
    });
    events.push({ type: 'draft_completed', draftId: ctx.draft.id, forfeited, reason });
  }
}

export function normalizeTeamNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function isValidTeamNumber(normalized: string): boolean {
  return /^[A-Z0-9]{1,8}$/.test(normalized);
}

/** "@user (Label)" style mention for a seat, or just the label if it has no users. */
export function mentionSeat(p: ParticipantWithUsers | null): string {
  if (!p) return 'an unknown participant';
  const mentions = p.users.map((u) => `<@${u.discordUserId}>`);
  if (mentions.length === 0) return `**${p.label}**`;
  const labelMatchesUser = p.users.length === 1;
  return labelMatchesUser ? `${mentions[0]} (${p.label})` : `**${p.label}** (${mentions.join(' ')})`;
}
