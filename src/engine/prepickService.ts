import { inTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import { DraftError } from '../domain/errors.js';
import type { Actor, ParticipantWithUsers, Prepick, Team } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import { loadContext, type DraftContext } from './context.js';

export interface PrepickEntry {
  prepick: Prepick;
  team: Team;
  available: boolean;
}

export const MAX_PREPICKS = 50;

export class PrepickService {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  list(draftId: number, participantId: number): PrepickEntry[] {
    const ctx = loadContext(this.repos, draftId);
    return this.repos.prepicks.list(participantId).map((prepick) => {
      const team = this.repos.teams.getById(prepick.teamId) as Team;
      const available = !team.removedAt && this.repos.assets.listActiveForTeam(team.id).length < ctx.config.maxInstancesPerTeam;
      return { prepick, team, available };
    });
  }

  add(draftId: number, participantId: number, teamId: number, actor: Actor, position?: number): PrepickEntry[] {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      this.assertAllowed(ctx);
      const participant = this.requireMember(ctx, participantId, actor);
      const team = this.repos.teams.getById(teamId);
      if (!team || team.draftId !== draftId) throw new DraftError('TEAM_NOT_FOUND', 'That team is not in this draft.');
      if (team.removedAt) throw new DraftError('TEAM_REMOVED', `Team ${team.teamNumber} has been removed from this draft.`);
      if (this.repos.assets.listActiveForTeam(team.id).length >= ctx.config.maxInstancesPerTeam) {
        throw new DraftError('TEAM_UNAVAILABLE', `Team ${team.teamNumber} has already been taken.`);
      }
      if (this.repos.prepicks.find(participantId, teamId)) throw new DraftError('PREPICK_ERROR', `Team ${team.teamNumber} is already in your prepick list.`);
      const existing = this.repos.prepicks.list(participantId);
      if (existing.length >= MAX_PREPICKS) throw new DraftError('PREPICK_ERROR', `You can have at most ${MAX_PREPICKS} prepicks.`);
      const now = this.clock.nowIso();
      const created = this.repos.prepicks.add({ draftId, participantId, teamId, priority: existing.length + 1, createdBy: actor.id, now });
      if (position !== undefined && position >= 1 && position <= existing.length) {
        const ids = existing.map((p) => p.id);
        ids.splice(position - 1, 0, created.id);
        this.repos.prepicks.reorder(participantId, ids);
      }
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'prepick_added',
        actor,
        summary: `"${participant.label}" added prepick ${team.teamNumber}${position ? ` at position ${position}` : ''}`,
        subject: { participantId, teamId },
        now,
      });
      return this.list(draftId, participantId);
    });
  }

  remove(draftId: number, participantId: number, teamId: number, actor: Actor): PrepickEntry[] {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const participant = this.requireMember(ctx, participantId, actor);
      const existing = this.repos.prepicks.find(participantId, teamId);
      const team = this.repos.teams.getById(teamId);
      if (!existing || !team) throw new DraftError('PREPICK_ERROR', `${team ? `Team ${team.teamNumber}` : 'That team'} is not in your prepick list.`);
      this.repos.prepicks.remove(existing.id);
      this.renumber(participantId);
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'prepick_removed',
        actor,
        summary: `"${participant.label}" removed prepick ${team.teamNumber}`,
        subject: { participantId, teamId },
        now: this.clock.nowIso(),
      });
      return this.list(draftId, participantId);
    });
  }

  clear(draftId: number, participantId: number, actor: Actor): number {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const participant = this.requireMember(ctx, participantId, actor);
      const removed = this.repos.prepicks.clear(participantId);
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'prepick_cleared',
        actor,
        summary: `"${participant.label}" cleared ${removed} prepick(s)`,
        subject: { participantId },
        now: this.clock.nowIso(),
      });
      return removed;
    });
  }

  /**
   * Reorders the list. `teamIds` lists the desired order; teams that are omitted keep
   * their relative order after the listed ones.
   */
  reorder(draftId: number, participantId: number, teamIds: number[], actor: Actor): PrepickEntry[] {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const participant = this.requireMember(ctx, participantId, actor);
      const existing = this.repos.prepicks.list(participantId);
      const byTeam = new Map(existing.map((p) => [p.teamId, p]));
      const ordered: number[] = [];
      const seen = new Set<number>();
      for (const teamId of teamIds) {
        const p = byTeam.get(teamId);
        if (!p) {
          const team = this.repos.teams.getById(teamId);
          throw new DraftError('PREPICK_ERROR', `${team ? `Team ${team.teamNumber}` : 'A listed team'} is not in your prepick list.`);
        }
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        ordered.push(p.id);
      }
      for (const p of existing) if (!seen.has(p.id)) ordered.push(p.id);
      const before = existing.map((p) => p.teamId);
      this.repos.prepicks.reorder(participantId, ordered);
      const after = this.repos.prepicks.list(participantId).map((p) => p.teamId);
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'prepick_reordered',
        actor,
        summary: `"${participant.label}" reordered prepicks`,
        subject: { participantId },
        before,
        after,
        now: this.clock.nowIso(),
      });
      return this.list(draftId, participantId);
    });
  }

  private renumber(participantId: number): void {
    const ids = this.repos.prepicks.list(participantId).map((p) => p.id);
    this.repos.prepicks.reorder(participantId, ids);
  }

  private assertAllowed(ctx: DraftContext): void {
    if (!ctx.config.allowPrepicks) throw new DraftError('PREPICK_ERROR', 'Prepicks are disabled for this draft.');
    if (ctx.draft.status === 'completed' || ctx.draft.status === 'archived') {
      throw new DraftError('INVALID_STATE', 'The draft is over; prepicks can no longer be changed.');
    }
  }

  private requireMember(ctx: DraftContext, participantId: number, actor: Actor): ParticipantWithUsers {
    const participant = this.repos.participants.getWithUsers(participantId);
    if (!participant || participant.draftId !== ctx.draft.id) throw new DraftError('PARTICIPANT_NOT_FOUND', 'That participant is not part of this draft.');
    if (actor.kind === 'user' && !this.repos.participants.isMember(participantId, actor.id)) {
      throw new DraftError('PERMISSION_DENIED', `You can only manage prepicks for seats you belong to. "${participant.label}" is not yours.`);
    }
    return participant;
  }
}
