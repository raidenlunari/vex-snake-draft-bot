import { inTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import { DraftError } from '../domain/errors.js';
import type { Actor, ParticipantWithUsers, PickSlot, Repick, Team } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import { loadContext, requireStatus, type DraftContext } from './context.js';
import type { DraftEvent } from './events.js';
import { instanceLimit } from './draftEngine.js';

export interface RepickView {
  repick: Repick;
  participant: ParticipantWithUsers;
  oldTeam: Team;
  proposedTeam: Team | null;
  slot: PickSlot | null;
}

/**
 * Repicks: when a drafted VEX team does not show up, an admin opens a repick for the
 * seat that holds it. The old team leaves the roster and the pool, the seat chooses a
 * replacement with /pick, and an admin approves it. The replacement inherits the
 * original pick number and round so history stays intact.
 */
export class RepickEngine {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  /** Admin: open a repick for the team on a seat's roster. */
  open(draftId: number, participantId: number, teamId: number, reason: string | null, actor: Actor): { view: RepickView; events: DraftEvent[] } {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['active', 'completed'], 'Opening a repick');
      const participant = this.requireParticipant(ctx, participantId);
      const team = this.requireTeam(ctx, teamId);
      const asset = this.repos.assets.findActiveTeamAsset(participantId, teamId);
      if (!asset) throw new DraftError('ASSET_NOT_FOUND', `Team ${team.teamNumber} is not on "${participant.label}"'s roster.`);
      const now = this.clock.nowIso();
      for (const trade of this.repos.trades.openTradesForAssets(draftId, [asset.id])) {
        this.repos.trades.setStatus(trade.id, 'cancelled', { resolvedAt: now, resolvedBy: actor.id, resolutionNote: `team ${team.teamNumber} entered a repick` });
      }
      this.repos.assets.setStatus(asset.id, 'removed', now);
      this.repos.teams.setRemoved(team.id, now, now);
      const prepicksRemoved = this.repos.prepicks.removeByTeam(draftId, team.id);
      const repick = this.repos.repicks.create({ draftId, participantId, assetId: asset.id, oldTeamId: team.id, pickSlotId: asset.pickSlotId, reason, openedBy: actor.id, now });
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'repick_opened',
        actor,
        summary: `Repick #${repick.id} opened for "${participant.label}": ${team.teamNumber} removed${reason ? ` (${reason})` : ''}`,
        subject: { repickId: repick.id, participantId, assetId: asset.id, teamId: team.id, prepicksRemoved },
        now,
      });
      const view = this.view(draftId, repick.id);
      return { view, events: [{ type: 'repick_opened', draftId, repick: view.repick, participant, oldTeam: team, slot: view.slot }] };
    });
  }

  /** Seat member (or admin): choose the replacement. Can be changed until an admin decides. */
  propose(draftId: number, repickId: number, teamId: number, actor: Actor): { view: RepickView; events: DraftEvent[] } {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const repick = this.requireRepick(ctx, repickId);
      if (repick.status !== 'open' && repick.status !== 'proposed') throw new DraftError('INVALID_STATE', `Repick #${repickId} is already ${repick.status}.`);
      const participant = this.requireParticipant(ctx, repick.participantId);
      if (actor.kind === 'user' && !this.repos.participants.isMember(participant.id, actor.id)) {
        throw new DraftError('PERMISSION_DENIED', `Only "${participant.label}" can choose this replacement.`);
      }
      const team = this.requireAvailableTeam(ctx, teamId);
      const now = this.clock.nowIso();
      this.repos.repicks.setProposal(repickId, team.id, actor.id, now);
      this.repos.repicks.setNote(repickId, null);
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'repick_proposed',
        actor,
        summary: `Repick #${repickId}: "${participant.label}" proposes ${team.teamNumber}`,
        subject: { repickId, participantId: participant.id, teamId: team.id },
        now,
      });
      const view = this.view(draftId, repickId);
      return { view, events: [{ type: 'repick_proposed', draftId, repick: view.repick, participant, oldTeam: view.oldTeam, newTeam: team, slot: view.slot }] };
    });
  }

  /** Admin: approve (execute) or deny (send back for another choice). */
  resolve(draftId: number, repickId: number, approve: boolean, note: string | null, actor: Actor): { view: RepickView; events: DraftEvent[] } {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const repick = this.requireRepick(ctx, repickId);
      if (repick.status !== 'proposed') throw new DraftError('INVALID_STATE', repick.status === 'open' ? `Repick #${repickId} has no replacement chosen yet.` : `Repick #${repickId} is already ${repick.status}.`);
      const participant = this.requireParticipant(ctx, repick.participantId);
      const now = this.clock.nowIso();
      const proposed = this.repos.teams.getById(repick.proposedTeamId as number) as Team;
      if (!approve) {
        this.repos.repicks.setProposal(repickId, null, null, null);
        this.repos.repicks.setNote(repickId, note);
        this.repos.audit.record({ guildId: ctx.draft.guildId, draftId, eventType: 'repick_denied', actor, summary: `Repick #${repickId}: ${proposed.teamNumber} denied${note ? ` (${note})` : ''}`, subject: { repickId, teamId: proposed.id }, now });
        const view = this.view(draftId, repickId);
        return { view, events: [{ type: 'repick_denied', draftId, repick: view.repick, participant, team: proposed, note }] };
      }
      const team = this.requireAvailableTeam(ctx, proposed.id);
      const asset = this.repos.assets.getById(repick.assetId);
      if (!asset) throw new DraftError('ASSET_NOT_FOUND', 'The roster entry for this repick no longer exists.');
      const oldTeam = this.repos.teams.getById(repick.oldTeamId) as Team;
      const slot = repick.pickSlotId ? this.repos.slots.getById(repick.pickSlotId) : null;
      const used = new Set(this.repos.assets.usedInstanceNumbers(team.id));
      let instance = 1;
      while (used.has(instance)) instance += 1;
      this.repos.assets.setTeam(asset.id, team.id, instance, now);
      this.repos.assets.setOwner(asset.id, participant.id, asset.acquiredVia === 'trade' ? 'trade' : 'pick', now);
      this.repos.assets.setStatus(asset.id, 'active', now);
      const oldPick = this.repos.picks.getActiveForAsset(asset.id);
      if (oldPick) this.repos.picks.void(oldPick.id, actor.id, `repick: ${oldTeam.teamNumber} replaced by ${team.teamNumber}`, now);
      this.repos.picks.create({
        draftId,
        pickSlotId: slot?.id ?? null,
        overallPick: slot?.overallPick ?? null,
        round: slot?.round ?? null,
        participantId: participant.id,
        teamId: team.id,
        assetId: asset.id,
        kind: 'repick',
        madeBy: repick.proposedBy ?? actor.id,
        now,
      });
      this.repos.prepicks.removeByTeam(draftId, team.id);
      this.repos.repicks.setStatus(repickId, 'approved', actor.id, now, note);
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'repick_approved',
        actor,
        summary: `Repick #${repickId} approved: "${participant.label}" ${oldTeam.teamNumber} → ${team.teamNumber}${slot ? ` (pick #${slot.overallPick})` : ''}`,
        subject: { repickId, assetId: asset.id, participantId: participant.id },
        before: { teamId: oldTeam.id, teamNumber: oldTeam.teamNumber },
        after: { teamId: team.id, teamNumber: team.teamNumber },
        now,
      });
      const view = this.view(draftId, repickId);
      return { view, events: [{ type: 'repick_completed', draftId, repick: view.repick, participant, oldTeam, newTeam: team, slot }] };
    });
  }

  /** Admin: abandon the repick, optionally putting the old team back. */
  cancel(draftId: number, repickId: number, restore: boolean, actor: Actor): { view: RepickView; events: DraftEvent[] } {
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      const repick = this.requireRepick(ctx, repickId);
      if (repick.status !== 'open' && repick.status !== 'proposed') throw new DraftError('INVALID_STATE', `Repick #${repickId} is already ${repick.status}.`);
      const participant = this.requireParticipant(ctx, repick.participantId);
      const oldTeam = this.repos.teams.getById(repick.oldTeamId) as Team;
      const now = this.clock.nowIso();
      let restored = false;
      if (restore) {
        const asset = this.repos.assets.getById(repick.assetId);
        if (asset && asset.status === 'removed') {
          this.repos.teams.setRemoved(oldTeam.id, null, now);
          this.repos.assets.setStatus(asset.id, 'active', now);
          restored = true;
        }
      }
      this.repos.repicks.setStatus(repickId, 'cancelled', actor.id, now, restored ? 'cancelled, team restored' : 'cancelled');
      this.repos.audit.record({ guildId: ctx.draft.guildId, draftId, eventType: 'repick_cancelled', actor, summary: `Repick #${repickId} cancelled${restored ? `; ${oldTeam.teamNumber} restored to "${participant.label}"` : ''}`, subject: { repickId, restored }, now });
      const view = this.view(draftId, repickId);
      return { view, events: [{ type: 'repick_cancelled', draftId, repick: view.repick, participant, oldTeam, restored }] };
    });
  }

  view(draftId: number, repickId: number): RepickView {
    const ctx = loadContext(this.repos, draftId);
    const repick = this.requireRepick(ctx, repickId);
    return {
      repick,
      participant: this.requireParticipant(ctx, repick.participantId),
      oldTeam: this.repos.teams.getById(repick.oldTeamId) as Team,
      proposedTeam: repick.proposedTeamId ? this.repos.teams.getById(repick.proposedTeamId) : null,
      slot: repick.pickSlotId ? this.repos.slots.getById(repick.pickSlotId) : null,
    };
  }

  listOpen(draftId: number): RepickView[] {
    return this.repos.repicks.listOpen(draftId).map((r) => this.view(draftId, r.id));
  }

  /** Open repicks the user may answer (through any of their seats). */
  openForUser(draftId: number, discordUserId: string): RepickView[] {
    return this.repos.participants.listSeatsForUser(draftId, discordUserId).flatMap((seat) => this.repos.repicks.listOpenForParticipant(seat.id).map((r) => this.view(draftId, r.id)));
  }

  private requireRepick(ctx: DraftContext, id: number): Repick {
    const r = this.repos.repicks.getById(id);
    if (!r || r.draftId !== ctx.draft.id) throw new DraftError('VALIDATION', `Repick #${id} does not exist in this draft.`);
    return r;
  }

  private requireParticipant(ctx: DraftContext, id: number): ParticipantWithUsers {
    const p = this.repos.participants.getWithUsers(id);
    if (!p || p.draftId !== ctx.draft.id) throw new DraftError('PARTICIPANT_NOT_FOUND', 'That participant is not part of this draft.');
    return p;
  }

  private requireTeam(ctx: DraftContext, id: number): Team {
    const t = this.repos.teams.getById(id);
    if (!t || t.draftId !== ctx.draft.id) throw new DraftError('TEAM_NOT_FOUND', 'That team is not in this draft.');
    return t;
  }

  private requireAvailableTeam(ctx: DraftContext, id: number): Team {
    const team = this.requireTeam(ctx, id);
    if (team.removedAt) throw new DraftError('TEAM_REMOVED', `Team ${team.teamNumber} has been removed from this draft.`);
    const used = this.repos.assets.listActiveForTeam(id);
    if (used.length >= instanceLimit(team, ctx.config)) {
      const owner = used[0] ? this.repos.participants.getById(used[0].currentParticipantId) : null;
      throw new DraftError('TEAM_UNAVAILABLE', `Team ${team.teamNumber} is no longer available${owner ? ` (on ${owner.label}'s roster)` : ''}.`);
    }
    return team;
  }
}
