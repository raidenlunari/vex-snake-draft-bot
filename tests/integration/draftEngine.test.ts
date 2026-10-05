import { beforeEach, describe, expect, it } from 'vitest';
import { DraftError } from '../../src/domain/errors.js';
import type { DraftEvent } from '../../src/engine/events.js';
import { ADMIN, createTestEnv, pickNextAvailable, setupDraft, teamByNumber, user, type TestEnv } from '../helpers/env.js';

function types(events: DraftEvent[]): string[] {
  return events.map((e) => e.type);
}

describe('draft setup', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it('creates one open draft per guild and records audit events', () => {
    const d = env.engine.createDraft({ guildId: 'g', name: 'Spring', actor: ADMIN });
    expect(d.status).toBe('setup');
    expect(() => env.engine.createDraft({ guildId: 'g', name: 'Another', actor: ADMIN })).toThrow(DraftError);
    expect(env.repos.audit.listByType(d.id, 'draft_created')).toHaveLength(1);
  });

  it('enforces seats-per-user and labels', () => {
    const d = env.engine.createDraft({ guildId: 'g', name: 'Spring', actor: ADMIN });
    env.engine.addParticipant(d.id, { label: 'Alice', discordUserIds: ['u1'], actor: ADMIN });
    expect(() => env.engine.addParticipant(d.id, { label: 'Alice 2', discordUserIds: ['u1'], actor: ADMIN })).toThrow(/already registered/);
    expect(() => env.engine.addParticipant(d.id, { label: 'alice', discordUserIds: ['u2'], actor: ADMIN })).toThrow(/already exists/);
    env.engine.updateConfig(d.id, { maxSeatsPerUser: 2 }, ADMIN);
    const second = env.engine.addParticipant(d.id, { label: 'Alice 2', discordUserIds: ['u1'], actor: ADMIN });
    expect(env.repos.participants.listSeatsForUser(d.id, 'u1')).toHaveLength(2);
    // multiple users on one seat
    env.engine.addUserToSeat(d.id, second.id, 'u3', ADMIN);
    expect(env.repos.participants.getWithUsers(second.id)?.users.map((u) => u.discordUserId)).toEqual(['u1', 'u3']);
  });

  it('randomizes securely and invalidates the order when participants change', () => {
    const { draftId, participants } = setupDraft(env, { participants: 6, randomize: false });
    const ordered = env.engine.randomize(draftId, ADMIN);
    expect(ordered.map((p) => p.draftPosition)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(ordered.map((p) => p.id))).toEqual(new Set(participants.map((p) => p.id)));
    expect(env.repos.drafts.getById(draftId)?.status).toBe('randomized');
    env.engine.addParticipant(draftId, { label: 'Late', discordUserIds: ['u99'], actor: ADMIN });
    expect(env.repos.drafts.getById(draftId)?.status).toBe('setup');
    expect(env.repos.participants.listByDraft(draftId).every((p) => p.draftPosition === null)).toBe(true);
  });

  it('refuses to start when not ready and prevents duplicate starts', () => {
    const d = env.engine.createDraft({ guildId: 'g', name: 'Spring', actor: ADMIN });
    expect(() => env.engine.start(d.id, ADMIN)).toThrow(/cannot start yet/);
    const { draftId } = setupDraft(env, { guildId: 'g2', start: true });
    expect(env.repos.drafts.getById(draftId)?.status).toBe('active');
    expect(() => env.engine.start(draftId, ADMIN)).toThrow(/already started/);
  });

  it('locks structural config once active', () => {
    const { draftId } = setupDraft(env, { start: true });
    expect(() => env.engine.updateConfig(draftId, { rounds: 5 }, ADMIN)).toThrow(/locked/);
    env.engine.updateConfig(draftId, { skipTimerSeconds: 60 }, ADMIN);
    expect(env.repos.drafts.getConfig(draftId).skipTimerSeconds).toBe(60);
  });
});

describe('picking', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it('materializes the snake order and walks through it', () => {
    const { draftId, order } = setupDraft(env, { participants: 4, start: true });
    const slots = env.repos.slots.listByDraft(draftId);
    expect(slots).toHaveLength(12);
    const ids = order.map((p) => p.id);
    expect(slots.map((s) => s.originalParticipantId)).toEqual([
      ids[0], ids[1], ids[2], ids[3], ids[3], ids[2], ids[1], ids[0], ids[0], ids[1], ids[2], ids[3],
    ]);
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(ids[0]);
    for (let i = 0; i < 12; i++) {
      const state = env.engine.getState(draftId);
      expect(state.currentSlot?.overallPick).toBe(i + 1);
      pickNextAvailable(env, draftId);
    }
    expect(env.repos.drafts.getById(draftId)?.status).toBe('completed');
    expect(env.repos.picks.listByDraft(draftId)).toHaveLength(12);
  });

  it('records round, pick number and owner for each pick and announces turns', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const first = order[0]!;
    const team = teamByNumber(env, draftId, '1001A');
    const events = env.engine.pick(draftId, { participantId: first.id, teamId: team.id, actor: user('u' + first.users[0]!.discordUserId.slice(1)) });
    expect(types(events)).toEqual(['pick_made', 'turn_started']);
    const pick = env.repos.picks.listByDraft(draftId)[0]!;
    expect(pick.overallPick).toBe(1);
    expect(pick.round).toBe(1);
    expect(pick.participantId).toBe(first.id);
    expect(pick.kind).toBe('pick');
    const roster = env.engine.getRoster(draftId, first.id);
    expect(roster.teams.map((t) => t.team.teamNumber)).toEqual(['1001A']);
    expect(env.engine.getTeamInfo(draftId, team.id).available).toBe(false);
  });

  it('rejects picks out of turn, by non-members, of unknown or taken teams', () => {
    const { draftId, order } = setupDraft(env, { participants: 3, start: true });
    const [a, b] = [order[0]!, order[1]!];
    const t1 = teamByNumber(env, draftId, '1001A');
    expect(() => env.engine.pick(draftId, { participantId: b.id, teamId: t1.id, actor: user(b.users[0]!.discordUserId) })).toThrow(/can't pick right now/);
    expect(() => env.engine.pick(draftId, { participantId: a.id, teamId: t1.id, actor: user('stranger') })).toThrow(/not a member/);
    expect(() => env.engine.pick(draftId, { participantId: a.id, teamId: 999999, actor: user(a.users[0]!.discordUserId) })).toThrow(/not in this draft/);
    env.engine.pick(draftId, { participantId: a.id, teamId: t1.id, actor: user(a.users[0]!.discordUserId) });
    expect(() => env.engine.pick(draftId, { participantId: b.id, teamId: t1.id, actor: user(b.users[0]!.discordUserId) })).toThrow(/no longer available.*pick #1/);
    expect(env.repos.picks.listByDraft(draftId)).toHaveLength(1);
  });

  it('supports multiple picks per round', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, config: { rounds: 2, picksPerRound: 2 }, start: true });
    const a = order[0]!;
    const b = order[1]!;
    const ev1 = env.engine.pick(draftId, { participantId: a.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: user('u' + a.users[0]!.discordUserId.slice(1)) });
    const turn = ev1.find((e) => e.type === 'turn_started');
    expect(turn && turn.type === 'turn_started' && turn.participant.id).toBe(a.id);
    expect(turn && turn.type === 'turn_started' && turn.pickIndexInTurn).toBe(2);
    expect(turn && turn.type === 'turn_started' && turn.picksThisTurn).toBe(2);
    env.engine.pick(draftId, { participantId: a.id, teamId: teamByNumber(env, draftId, '1002A').id, actor: ADMIN });
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(b.id);
    expect(() => env.engine.pick(draftId, { participantId: a.id, teamId: teamByNumber(env, draftId, '1003A').id, actor: ADMIN })).toThrow(/can't pick right now/);
    expect(env.engine.getState(draftId).currentSlot?.overallPick).toBe(3);
  });

  it('allows duplicate team instances when configured and reports each instance', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 3, config: { rounds: 2, maxInstancesPerTeam: 2 }, start: true });
    const t = teamByNumber(env, draftId, '1001A');
    env.engine.pick(draftId, { participantId: order[0]!.id, teamId: t.id, actor: ADMIN });
    env.engine.pick(draftId, { participantId: order[1]!.id, teamId: t.id, actor: ADMIN });
    const info = env.engine.getTeamInfo(draftId, t.id);
    expect(info.instancesUsed).toBe(2);
    expect(info.available).toBe(false);
    expect(info.owners.map((o) => o.overallPick)).toEqual([1, 2]);
    expect(() => env.engine.pick(draftId, { participantId: order[1]!.id, teamId: t.id, actor: ADMIN })).toThrow(/all 2 copies/);
  });

  it('completes early when the team pool is exhausted', () => {
    const { draftId } = setupDraft(env, { participants: 2, teams: 3, config: { rounds: 3 }, start: true });
    pickNextAvailable(env, draftId);
    pickNextAvailable(env, draftId);
    const events = (() => {
      const turn = env.engine.currentTurn(draftId)!;
      const last = env.repos.teams.listAvailable(draftId, 1)[0]!;
      return env.engine.pick(draftId, { participantId: turn.owner.id, teamId: last.id, actor: ADMIN });
    })();
    const done = events.find((e) => e.type === 'draft_completed');
    expect(done && done.type === 'draft_completed' && done.reason).toBe('pool_empty');
    expect(env.repos.drafts.getById(draftId)?.status).toBe('completed');
  });
});

describe('skips', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it('admin skip advances and lets the skipped player catch up later', () => {
    const { draftId, order } = setupDraft(env, { participants: 3, start: true });
    const a = order[0]!;
    const events = env.engine.skipCurrent(draftId, ADMIN);
    expect(types(events)).toEqual(['turn_skipped', 'turn_started']);
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(order[1]!.id);
    expect(env.engine.catchUpSeatsForUser(draftId, a.users[0]!.discordUserId).map((p) => p.id)).toEqual([a.id]);
    const catchUp = env.engine.pick(draftId, { participantId: a.id, teamId: teamByNumber(env, draftId, '1005A').id, actor: user(a.users[0]!.discordUserId) });
    expect(types(catchUp)).toEqual(['pick_made']);
    const pick = env.repos.picks.listByDraft(draftId).find((p) => p.participantId === a.id)!;
    expect(pick.overallPick).toBe(1);
    expect(pick.kind).toBe('catch_up');
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('picked');
    // current turn unaffected
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(order[1]!.id);
  });

  it('forfeits the pick when the policy says so', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, config: { afterSkipPolicy: 'forfeit' }, start: true });
    env.engine.skipCurrent(draftId, ADMIN);
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('forfeited');
    expect(() => env.engine.pick(draftId, { participantId: order[0]!.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: ADMIN })).toThrow(/can't pick right now/);
  });

  it('forfeits open skipped slots when the draft ends', () => {
    const { draftId } = setupDraft(env, { participants: 2, config: { rounds: 1 }, start: true });
    env.engine.skipCurrent(draftId, ADMIN);
    const events = env.engine.skipCurrent(draftId, ADMIN);
    const done = events.find((e) => e.type === 'draft_completed');
    expect(done && done.type === 'draft_completed' && done.forfeited.length).toBe(2);
    expect(env.repos.slots.countByStatus(draftId).forfeited).toBe(2);
  });

  it('expireTurn is idempotent and token-guarded', () => {
    const { draftId } = setupDraft(env, { participants: 2, config: { skipTimerSeconds: 60 }, start: true });
    const draft = env.repos.drafts.getById(draftId)!;
    expect(draft.turnDeadlineAt).not.toBeNull();
    // Too early: nothing happens.
    expect(env.engine.expireTurn(draftId, draft.turnToken!)).toEqual([]);
    env.clock.advance(61_000);
    // Wrong token: nothing happens.
    expect(env.engine.expireTurn(draftId, 'bogus')).toEqual([]);
    const events = env.engine.expireTurn(draftId, draft.turnToken!);
    expect(types(events)).toEqual(['turn_skipped', 'turn_started']);
    // Firing again with the old token is a no-op.
    expect(env.engine.expireTurn(draftId, draft.turnToken!)).toEqual([]);
    const after = env.repos.drafts.getById(draftId)!;
    expect(after.turnToken).not.toBe(draft.turnToken);
    expect(env.repos.audit.listByType(draftId, 'pick_skipped')).toHaveLength(1);
  });
});

describe('prepicks', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it('applies prepicks immediately when the turn arrives, falling back to the next available', () => {
    const { draftId, order } = setupDraft(env, { participants: 3, start: true });
    const [a, b] = [order[0]!, order[1]!];
    const bUser = user(b.users[0]!.discordUserId);
    const t1 = teamByNumber(env, draftId, '1001A');
    const t2 = teamByNumber(env, draftId, '1002A');
    env.prepicks.add(draftId, b.id, t1.id, bUser);
    env.prepicks.add(draftId, b.id, t2.id, bUser);
    expect(env.prepicks.list(draftId, b.id).map((e) => e.team.teamNumber)).toEqual(['1001A', '1002A']);
    // A takes B's first choice.
    const events = env.engine.pick(draftId, { participantId: a.id, teamId: t1.id, actor: user(a.users[0]!.discordUserId) });
    expect(types(events)).toEqual(['pick_made', 'turn_started', 'prepick_dropped', 'pick_made', 'turn_started']);
    const bPick = env.repos.picks.listByDraft(draftId).find((p) => p.participantId === b.id)!;
    expect(bPick.teamId).toBe(t2.id);
    expect(bPick.kind).toBe('prepick');
    expect(env.prepicks.list(draftId, b.id)).toEqual([]);
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(order[2]!.id);
    expect(env.repos.audit.listByType(draftId, 'prepick_applied')).toHaveLength(1);
  });

  it('chains prepicks across consecutive turns', () => {
    const { draftId, order } = setupDraft(env, { participants: 3, config: { rounds: 1 }, start: true });
    const b = order[1]!;
    const c = order[2]!;
    env.prepicks.add(draftId, b.id, teamByNumber(env, draftId, '1010A').id, ADMIN);
    env.prepicks.add(draftId, c.id, teamByNumber(env, draftId, '1011A').id, ADMIN);
    const events = env.engine.pick(draftId, { participantId: order[0]!.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: ADMIN });
    expect(events.filter((e) => e.type === 'pick_made')).toHaveLength(3);
    expect(env.repos.drafts.getById(draftId)?.status).toBe('completed');
  });

  it('applies prepicks only on timeout when configured', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, config: { prepickMode: 'on_timeout', skipTimerSeconds: 30 }, start: true });
    const a = order[0]!;
    env.prepicks.add(draftId, a.id, teamByNumber(env, draftId, '1003A').id, ADMIN);
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(a.id);
    expect(env.repos.picks.listByDraft(draftId)).toHaveLength(0);
    env.clock.advance(31_000);
    const events = env.engine.expireTurn(draftId, env.repos.drafts.getById(draftId)!.turnToken!);
    expect(types(events)).toEqual(['pick_made', 'turn_started']);
    expect(env.repos.picks.listByDraft(draftId)[0]?.kind).toBe('prepick');
  });

  it('manages the list: add, remove, reorder, clear, with validation', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const b = order[1]!;
    const bUser = user(b.users[0]!.discordUserId);
    const [t1, t2, t3] = ['1001A', '1002A', '1003A'].map((n) => teamByNumber(env, draftId, n)) as [typeof order[0] extends never ? never : ReturnType<typeof teamByNumber>, ReturnType<typeof teamByNumber>, ReturnType<typeof teamByNumber>];
    env.prepicks.add(draftId, b.id, t1.id, bUser);
    env.prepicks.add(draftId, b.id, t2.id, bUser);
    env.prepicks.add(draftId, b.id, t3.id, bUser, 1);
    expect(env.prepicks.list(draftId, b.id).map((e) => e.team.teamNumber)).toEqual(['1003A', '1001A', '1002A']);
    expect(() => env.prepicks.add(draftId, b.id, t1.id, bUser)).toThrow(/already in your prepick list/);
    expect(() => env.prepicks.add(draftId, b.id, t1.id, user('someone-else'))).toThrow(/not yours/);
    env.prepicks.reorder(draftId, b.id, [t2.id, t1.id], bUser);
    expect(env.prepicks.list(draftId, b.id).map((e) => e.team.teamNumber)).toEqual(['1002A', '1001A', '1003A']);
    env.prepicks.remove(draftId, b.id, t1.id, bUser);
    expect(env.prepicks.list(draftId, b.id).map((e) => e.prepick.priority)).toEqual([1, 2]);
    expect(env.prepicks.clear(draftId, b.id, bUser)).toBe(2);
    env.engine.updateConfig(draftId, { allowPrepicks: false }, ADMIN);
    expect(() => env.prepicks.add(draftId, b.id, t1.id, bUser)).toThrow(/disabled/);
  });

  it('cannot bypass draft rules (removed or taken teams are rejected)', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const t = teamByNumber(env, draftId, '1001A');
    env.engine.pick(draftId, { participantId: order[0]!.id, teamId: t.id, actor: ADMIN });
    expect(() => env.prepicks.add(draftId, order[1]!.id, t.id, ADMIN)).toThrow(/already been taken/);
    const removed = teamByNumber(env, draftId, '1002A');
    env.engine.removeTeam(draftId, removed.id, { force: false }, ADMIN);
    expect(() => env.prepicks.add(draftId, order[1]!.id, removed.id, ADMIN)).toThrow(/removed/);
  });
});

describe('admin corrections and roster management', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  it('forces a pick on behalf of the current player', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const events = env.engine.pick(draftId, { participantId: order[0]!.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: ADMIN, kind: 'forced' });
    expect(types(events)[0]).toBe('pick_made');
    expect(env.repos.picks.listByDraft(draftId)[0]?.kind).toBe('forced');
    expect(env.repos.audit.listByType(draftId, 'pick_forced')).toHaveLength(1);
  });

  it('corrects a pick while preserving history', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const a = order[0]!;
    const wrong = teamByNumber(env, draftId, '1001A');
    const right = teamByNumber(env, draftId, '1002A');
    env.engine.pick(draftId, { participantId: a.id, teamId: wrong.id, actor: ADMIN });
    const events = env.engine.adminReplaceTeam(draftId, { overallPick: 1 }, right.id, ADMIN);
    expect(types(events)).toEqual(['pick_corrected']);
    const roster = env.engine.getRoster(draftId, a.id);
    expect(roster.teams.map((t) => t.team.teamNumber)).toEqual(['1002A']);
    expect(roster.teams[0]?.overallPick).toBe(1);
    expect(env.engine.getTeamInfo(draftId, wrong.id).available).toBe(true);
    const history = env.repos.picks.listByDraft(draftId, { includeVoided: true });
    expect(history).toHaveLength(2);
    expect(history[0]?.voidedAt).not.toBeNull();
    expect(history[1]?.kind).toBe('correction');
    const audit = env.repos.audit.listByType(draftId, 'pick_corrected')[0]!;
    expect(audit.before).toMatchObject({ teamNumber: '1001A' });
    expect(audit.after).toMatchObject({ teamNumber: '1002A' });
  });

  it('adds, drops, moves teams and removes/restores teams from the pool', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const [a, b] = [order[0]!, order[1]!];
    const t1 = teamByNumber(env, draftId, '1001A');
    const t2 = teamByNumber(env, draftId, '1002A');
    env.engine.adminAddTeam(draftId, b.id, t1.id, ADMIN);
    expect(env.engine.getRoster(draftId, b.id).teams.map((t) => t.team.teamNumber)).toEqual(['1001A']);
    expect(env.engine.getRoster(draftId, b.id).teams[0]?.overallPick).toBeNull();
    expect(() => env.engine.pick(draftId, { participantId: a.id, teamId: t1.id, actor: ADMIN })).toThrow(/no longer available/);

    env.engine.adminMoveTeam(draftId, b.id, a.id, t1.id, ADMIN);
    expect(env.engine.getRoster(draftId, a.id).teams.map((t) => t.team.teamNumber)).toEqual(['1001A']);
    expect(env.engine.getRoster(draftId, a.id).teams[0]?.transfers[0]?.reason).toBe('admin_move');

    env.engine.adminDropTeam(draftId, a.id, t1.id, { removeFromPool: false }, ADMIN);
    expect(env.engine.getRoster(draftId, a.id).teams).toEqual([]);
    expect(env.engine.getTeamInfo(draftId, t1.id).available).toBe(true);

    env.engine.adminAddTeam(draftId, a.id, t2.id, ADMIN);
    expect(() => env.engine.removeTeam(draftId, t2.id, { force: false }, ADMIN)).toThrow(/on a roster/);
    const removal = env.engine.removeTeam(draftId, t2.id, { force: true }, ADMIN);
    expect(removal.droppedFrom.map((p) => p.id)).toEqual([a.id]);
    expect(env.engine.getTeamInfo(draftId, t2.id).removed).toBe(true);
    expect(() => env.engine.pick(draftId, { participantId: a.id, teamId: t2.id, actor: ADMIN })).toThrow(/removed/);
    env.engine.restoreTeam(draftId, t2.id, ADMIN);
    expect(env.engine.getTeamInfo(draftId, t2.id).available).toBe(true);
    expect(env.repos.audit.listByType(draftId, 'team_removed')).toHaveLength(1);
    expect(env.repos.audit.listByType(draftId, 'team_restored')).toHaveLength(1);
  });

  it('removing a team clears it from prepick lists', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const b = order[1]!;
    const t = teamByNumber(env, draftId, '1009A');
    env.prepicks.add(draftId, b.id, t.id, ADMIN);
    const res = env.engine.removeTeam(draftId, t.id, { force: false }, ADMIN);
    expect(res.prepicksRemoved).toBe(1);
    expect(env.prepicks.list(draftId, b.id)).toEqual([]);
  });

  it('admin can end the draft early', () => {
    const { draftId } = setupDraft(env, { participants: 2, start: true });
    pickNextAvailable(env, draftId);
    const events = env.engine.complete(draftId, ADMIN);
    expect(types(events)).toEqual(['draft_completed']);
    expect(env.repos.drafts.getById(draftId)?.status).toBe('completed');
    expect(env.repos.slots.countByStatus(draftId).void).toBe(4);
    expect(env.repos.slots.countByStatus(draftId).forfeited).toBe(1);
  });
});

describe('team search', () => {
  it('reports availability and owners with pick numbers and trade flags', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, start: true });
    const t = teamByNumber(env, draftId, '1001A');
    expect(env.engine.getTeamInfo(draftId, t.id)).toMatchObject({ available: true, instancesUsed: 0, owners: [] });
    env.engine.pick(draftId, { participantId: order[0]!.id, teamId: t.id, actor: ADMIN });
    const info = env.engine.getTeamInfo(draftId, t.id);
    expect(info.available).toBe(false);
    expect(info.owners[0]).toMatchObject({ overallPick: 1, round: 1, viaTrade: false });
    expect(info.owners[0]?.participant.id).toBe(order[0]!.id);
    expect(() => env.engine.getTeamInfo(draftId, 424242)).toThrow(/not in this draft/);
  });
});

describe('reset', () => {
  it('archives the draft, keeps history and allows a new draft immediately', () => {
    const env = createTestEnv();
    const { draftId } = setupDraft(env, { participants: 2, guildId: 'g', start: true });
    pickNextAvailable(env, draftId);
    const auditBefore = env.repos.audit.countForDraft(draftId);
    const result = env.engine.reset(draftId, ADMIN, { purge: false });
    expect(result.purged).toBe(false);
    expect(result.draft.status).toBe('archived');
    expect(result.draft.turnToken).toBeNull();
    expect(env.repos.picks.listByDraft(draftId)).toHaveLength(1);
    expect(env.repos.audit.countForDraft(draftId)).toBe(auditBefore + 1);
    expect(env.repos.drafts.getOpenForGuild('g')).toBeNull();
    const fresh = env.engine.createDraft({ guildId: 'g', name: 'Next', actor: ADMIN });
    expect(fresh.status).toBe('setup');
    expect(() => env.engine.reset(draftId, ADMIN, { purge: false })).toThrow(/already reset/);
  });

  it('purges rows but keeps audit events', () => {
    const env = createTestEnv();
    const { draftId } = setupDraft(env, { participants: 2, guildId: 'g', start: true });
    pickNextAvailable(env, draftId);
    const result = env.engine.reset(draftId, ADMIN, { purge: true });
    expect(result.purged).toBe(true);
    expect(env.repos.drafts.getById(draftId)).toBeNull();
    expect(env.repos.participants.listByDraft(draftId)).toEqual([]);
    expect(env.repos.teams.listByDraft(draftId)).toEqual([]);
    expect(env.repos.audit.countForDraft(draftId)).toBeGreaterThan(0);
    expect(env.repos.audit.listByType(draftId, 'draft_reset')).toHaveLength(1);
  });
});

describe('team seats (several users on one participant)', () => {
  it('registers several users as one seat and lets any member act for it', () => {
    const env = createTestEnv();
    const d = env.engine.createDraft({ guildId: 'g', name: 'Teams', actor: ADMIN });
    env.engine.updateConfig(d.id, { rounds: 1 }, ADMIN);
    env.engine.setChannel(d.id, { channelId: 'c', kind: 'text', parentChannelId: null }, ADMIN);
    const team = env.engine.addParticipant(d.id, { label: 'Team 1234A', discordUserIds: ['t1', 't2', 't2', 't3'], actor: ADMIN });
    expect(team.users.map((u) => u.discordUserId)).toEqual(['t1', 't2', 't3']);
    expect(team.users.every((u) => u.role === 'owner')).toBe(true);
    env.engine.addParticipant(d.id, { label: 'Solo', discordUserIds: ['s1'], actor: ADMIN });
    expect(() => env.engine.addParticipant(d.id, { label: 'Dup', discordUserIds: ['x1', 't2'], actor: ADMIN })).toThrow(/already registered/);
    for (let i = 1; i <= 3; i++) env.engine.addTeam(d.id, { teamNumber: `${i}A`, teamName: null, organization: null, location: null }, ADMIN);
    const order = env.engine.randomize(d.id, ADMIN);
    env.engine.start(d.id, ADMIN);
    const first = order[0]!;
    const member = first.id === team.id ? user('t3') : user('s1');
    const t = teamByNumber(env, d.id, '1A');
    env.engine.pick(d.id, { participantId: first.id, teamId: t.id, actor: member });
    expect(env.engine.getRoster(d.id, first.id).teams).toHaveLength(1);
    // a non-member cannot act for the team
    const second = order[1]!;
    expect(() => env.engine.pick(d.id, { participantId: second.id, teamId: teamByNumber(env, d.id, '2A').id, actor: user('stranger') })).toThrow(/not a member/);
    expect(() => env.prepicks.add(d.id, team.id, teamByNumber(env, d.id, '3A').id, user('s1'))).toThrow(/not yours/);
    env.prepicks.add(d.id, team.id, teamByNumber(env, d.id, '3A').id, user('t1'));
    expect(env.prepicks.list(d.id, team.id)).toHaveLength(1);
  });
});

describe('per-team pick limits', () => {
  it('a team override beats the draft-wide copy limit', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 3, teams: 5, config: { rounds: 1, maxInstancesPerTeam: 1 }, start: true });
    const special = teamByNumber(env, draftId, '1001A');
    env.engine.setTeamLimit(draftId, special.id, 2, ADMIN);
    expect(env.repos.teams.getById(special.id)?.maxInstances).toBe(2);
    env.engine.pick(draftId, { participantId: order[0]!.id, teamId: special.id, actor: ADMIN });
    expect(env.engine.getTeamInfo(draftId, special.id)).toMatchObject({ available: true, instancesUsed: 1, maxInstances: 2 });
    expect(env.repos.teams.listAvailableWithCounts(draftId, 1).find((t) => t.id === special.id)).toMatchObject({ used: 1, limit: 2 });
    env.engine.pick(draftId, { participantId: order[1]!.id, teamId: special.id, actor: ADMIN });
    expect(() => env.engine.pick(draftId, { participantId: order[2]!.id, teamId: special.id, actor: ADMIN })).toThrow(/all 2 copies/);
    expect(env.repos.teams.countAvailable(draftId, 1)).toBe(4);
    env.engine.setTeamLimit(draftId, special.id, null, ADMIN);
    expect(env.engine.getTeamInfo(draftId, special.id).maxInstances).toBe(1);
    expect(() => env.engine.setTeamLimit(draftId, special.id, 99, ADMIN)).toThrow(/between 1 and 50/);
    expect(env.repos.audit.listByType(draftId, 'team_limit_changed')).toHaveLength(2);
  });
});
