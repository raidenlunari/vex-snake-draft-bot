import { describe, expect, it } from 'vitest';
import { ADMIN, createTestEnv, pickNextAvailable, setupDraft, teamByNumber, user } from '../helpers/env.js';

describe('repicks', () => {
  it('runs the no-show workflow: admin opens, drafter chooses, admin approves, pick number preserved', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 6, config: { rounds: 1 }, start: true });
    pickNextAvailable(env, draftId);
    pickNextAvailable(env, draftId);
    expect(env.repos.drafts.getById(draftId)?.status).toBe('completed'); // repicks happen at the event, after the draft
    const a = order[0]!;
    const aUser = user(a.users[0]!.discordUserId);
    const bUser = user(order[1]!.users[0]!.discordUserId);
    const noShow = env.engine.getRoster(draftId, a.id).teams[0]!.team;

    // only admins open repicks (the engine is called by admin commands; users have no path to it)
    const opened = env.repicks.open(draftId, a.id, noShow.id, 'no-show', ADMIN);
    expect(opened.events.map((e) => e.type)).toEqual(['repick_opened']);
    expect(env.engine.getRoster(draftId, a.id).teams).toEqual([]);
    expect(env.engine.getTeamInfo(draftId, noShow.id).removed).toBe(true);
    expect(env.repicks.openForUser(draftId, aUser.id)).toHaveLength(1);
    expect(env.repicks.openForUser(draftId, bUser.id)).toHaveLength(0);

    const replacement = teamByNumber(env, draftId, '1005A');
    expect(() => env.repicks.propose(draftId, opened.view.repick.id, replacement.id, bUser)).toThrow(/Only/);
    const taken = env.engine.getRoster(draftId, order[1]!.id).teams[0]!.team;
    expect(() => env.repicks.propose(draftId, opened.view.repick.id, taken.id, aUser)).toThrow(/no longer available/);
    const proposed = env.repicks.propose(draftId, opened.view.repick.id, replacement.id, aUser);
    expect(proposed.view.repick.status).toBe('proposed');
    expect(proposed.events[0]?.type).toBe('repick_proposed');

    // deny -> back to open, choose again
    const denied = env.repicks.resolve(draftId, opened.view.repick.id, false, 'pick a closer team', ADMIN);
    expect(denied.view.repick.status).toBe('open');
    expect(denied.events[0]?.type).toBe('repick_denied');
    expect(() => env.repicks.resolve(draftId, opened.view.repick.id, true, null, ADMIN)).toThrow(/no replacement chosen/);
    const other = teamByNumber(env, draftId, '1006A');
    env.repicks.propose(draftId, opened.view.repick.id, other.id, aUser);

    const approved = env.repicks.resolve(draftId, opened.view.repick.id, true, null, ADMIN);
    expect(approved.view.repick.status).toBe('approved');
    expect(approved.events[0]?.type).toBe('repick_completed');
    const roster = env.engine.getRoster(draftId, a.id);
    expect(roster.teams.map((t) => t.team.teamNumber)).toEqual(['1006A']);
    expect(roster.teams[0]?.overallPick).toBe(1);
    const history = env.repos.picks.listByDraft(draftId, { includeVoided: true }).filter((p) => p.participantId === a.id);
    expect(history.map((p) => p.kind)).toEqual(['pick', 'repick']);
    expect(history[0]?.voidedAt).not.toBeNull();
    expect(env.engine.getTeamInfo(draftId, other.id).owners[0]?.overallPick).toBe(1);
    expect(env.repos.audit.listByType(draftId, 'repick_approved')).toHaveLength(1);
    expect(() => env.repicks.resolve(draftId, opened.view.repick.id, true, null, ADMIN)).toThrow(/already approved/);
  });

  it('cancel restores the original team by default', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 4, config: { rounds: 1 }, start: true });
    pickNextAvailable(env, draftId);
    const a = order[0]!;
    const team = env.engine.getRoster(draftId, a.id).teams[0]!.team;
    const { view } = env.repicks.open(draftId, a.id, team.id, null, ADMIN);
    const cancelled = env.repicks.cancel(draftId, view.repick.id, true, ADMIN);
    expect(cancelled.view.repick.status).toBe('cancelled');
    expect(cancelled.events[0]).toMatchObject({ type: 'repick_cancelled', restored: true });
    expect(env.engine.getRoster(draftId, a.id).teams.map((t) => t.team.id)).toEqual([team.id]);
    expect(env.engine.getTeamInfo(draftId, team.id).removed).toBe(false);
  });

  it('late joiners can be added to a team after the draft is complete', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 4, config: { rounds: 1 }, start: true });
    pickNextAvailable(env, draftId);
    pickNextAvailable(env, draftId);
    const seat = env.engine.addUserToSeat(draftId, order[0]!.id, 'late-joiner', ADMIN);
    expect(seat.users.map((u) => u.discordUserId)).toContain('late-joiner');
    const team = env.engine.getRoster(draftId, seat.id).teams[0]!.team;
    const { view } = env.repicks.open(draftId, seat.id, team.id, null, ADMIN);
    const pick = env.repos.teams.listAvailable(draftId, 1)[0]!;
    expect(env.repicks.propose(draftId, view.repick.id, pick.id, user('late-joiner')).view.repick.status).toBe('proposed');
  });
});
