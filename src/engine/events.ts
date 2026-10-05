import type { DraftPick, ParticipantWithUsers, PickKind, PickSlot, Repick, Team, Trade } from '../domain/types.js';

/**
 * Events produced by engine operations. They describe what happened inside the
 * transaction so the service layer can announce it and re-arm timers after commit.
 */
export type DraftEvent =
  | { type: 'draft_started'; draftId: number; order: ParticipantWithUsers[]; totalPicks: number }
  | {
      type: 'pick_made';
      draftId: number;
      pick: DraftPick;
      team: Team;
      participant: ParticipantWithUsers;
      slot: PickSlot | null;
      kind: PickKind;
      actorId: string;
    }
  | {
      type: 'turn_started';
      draftId: number;
      participant: ParticipantWithUsers;
      slot: PickSlot;
      deadline: string | null;
      pickIndexInTurn: number;
      picksThisTurn: number;
      totalPicks: number;
      /** The next distinct seats after this one, in order (on deck, in the hole, 4th, 5th). */
      upcoming: ParticipantWithUsers[];
      /** Seat ids that have at least one still-available prepick; they are not pinged. */
      autoPickerIds: number[];
    }
  | {
      type: 'turn_skipped';
      draftId: number;
      participant: ParticipantWithUsers;
      slot: PickSlot;
      reason: 'admin' | 'timer';
      catchUpAllowed: boolean;
      actorId: string;
    }
  | { type: 'prepick_dropped'; draftId: number; participant: ParticipantWithUsers; team: Team; reason: string }
  | { type: 'draft_completed'; draftId: number; forfeited: PickSlot[]; reason: 'all_slots' | 'pool_empty' | 'admin' }
  | {
      type: 'pick_corrected';
      draftId: number;
      participant: ParticipantWithUsers;
      oldTeam: Team;
      newTeam: Team;
      slot: PickSlot | null;
      actorId: string;
    }
  | { type: 'roster_changed'; draftId: number; summary: string; actorId: string }
  | { type: 'team_swapped'; draftId: number; participant: ParticipantWithUsers; oldTeam: Team; newTeam: Team; slot: PickSlot | null }
  | { type: 'trade_executed'; draftId: number; trade: Trade; summary: string }
  | { type: 'trade_failed'; draftId: number; trade: Trade; reason: string }
  | { type: 'repick_opened'; draftId: number; repick: Repick; participant: ParticipantWithUsers; oldTeam: Team; slot: PickSlot | null }
  | { type: 'repick_proposed'; draftId: number; repick: Repick; participant: ParticipantWithUsers; oldTeam: Team; newTeam: Team; slot: PickSlot | null }
  | { type: 'repick_completed'; draftId: number; repick: Repick; participant: ParticipantWithUsers; oldTeam: Team; newTeam: Team; slot: PickSlot | null }
  | { type: 'repick_denied'; draftId: number; repick: Repick; participant: ParticipantWithUsers; team: Team; note: string | null }
  | { type: 'repick_cancelled'; draftId: number; repick: Repick; participant: ParticipantWithUsers; oldTeam: Team; restored: boolean };
