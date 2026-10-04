import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestEnv, pickNextAvailable, setupDraft, user, type TestEnv } from '../helpers/env.js';

describe('trades', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = createTestEnv();
  });

  function twoPlayersWithTeams(config: Parameters<typeof setupDraft>[1] = {}) {
    const res = setupDraft(env, { ...config, participants: 2, config: { rounds: 4, ...config?.config }, start: true });
    // Round 1 and 2: each player drafts two teams (snake: A, B, B, A).
    for (let i = 0; i < 4; i++) pickNextAvailable(env, res.draftId);
    return res;
  }

  it('executes a team-for-team trade after the counterparty accepts', () => {
    const { draftId, order } = twoPlayersWithTeams();
    const [a, b] = [order[0]!, order[1]!];
    const aUser = user(a.users[0]!.discordUserId);
    const bUser = user(b.users[0]!.discordUserId);
    const aTeam = env.engine.getRoster(draftId, a.id).teams[0]!.team;
    const bTeam = env.engine.getRoster(draftId, b.id).teams[0]!.team;
    const give = env.trades.resolveAssetRefs(draftId, a.id, [aTeam.teamNumber]);
    const receive = env.trades.resolveAssetRefs(draftId, b.id, [bTeam.teamNumber]);
    const { view, events } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: aUser });
    expect(view.trade.status).toBe('proposed');
    expect(events).toEqual([]);
    expect(() => env.trades.respond(draftId, view.trade.id, true, aUser)).toThrow(/Only/);
    const res = env.trades.respond(draftId, view.trade.id, true, bUser);
    expect(res.executed).toBe(true);
    expect(res.view.trade.status).toBe('executed');
    expect(res.events.map((e) => e.type)).toEqual(['trade_executed']);
    expect(env.engine.getRoster(draftId, a.id).teams.map((t) => t.team.id)).toContain(bTeam.id);
    expect(env.engine.getRoster(draftId, b.id).teams.map((t) => t.team.id)).toContain(aTeam.id);
    const moved = env.engine.getRoster(draftId, b.id).teams.find((t) => t.team.id === aTeam.id)!;
    expect(moved.originalOwner?.id).toBe(a.id);
    expect(moved.overallPick).toBe(1);
    expect(moved.transfers).toHaveLength(1);
    expect(env.engine.getTeamInfo(draftId, aTeam.id).owners[0]).toMatchObject({ viaTrade: true, overallPick: 1 });
    expect(env.repos.audit.listByType(draftId, 'trade_executed')).toHaveLength(1);
  });

  it('rejects and cancels trades', () => {
    const { draftId, order } = twoPlayersWithTeams();
    const [a, b] = [order[0]!, order[1]!];
    const give = env.trades.resolveAssetRefs(draftId, a.id, [env.engine.getRoster(draftId, a.id).teams[0]!.team.teamNumber]);
    const receive = env.trades.resolveAssetRefs(draftId, b.id, [env.engine.getRoster(draftId, b.id).teams[0]!.team.teamNumber]);
    const t1 = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    const rejected = env.trades.respond(draftId, t1.view.trade.id, false, user(b.users[0]!.discordUserId));
    expect(rejected.view.trade.status).toBe('rejected');
    const t2 = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    expect(() => env.trades.cancel(draftId, t2.view.trade.id, user('nobody'))).toThrow(/Only the two parties/);
    expect(env.trades.cancel(draftId, t2.view.trade.id, user(a.users[0]!.discordUserId)).trade.status).toBe('cancelled');
    expect(env.trades.listOpen(draftId)).toEqual([]);
  });

  it('requires admin approval when configured', () => {
    const { draftId, order } = twoPlayersWithTeams({ config: { tradeApproval: 'admin' } });
    const [a, b] = [order[0]!, order[1]!];
    const give = env.trades.resolveAssetRefs(draftId, a.id, [env.engine.getRoster(draftId, a.id).teams[0]!.team.teamNumber]);
    const receive = env.trades.resolveAssetRefs(draftId, b.id, [env.engine.getRoster(draftId, b.id).teams[0]!.team.teamNumber]);
    const { view } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    expect(() => env.trades.adminResolve(draftId, view.trade.id, true, ADMIN)).toThrow(/not been accepted/);
    const accepted = env.trades.respond(draftId, view.trade.id, true, user(b.users[0]!.discordUserId));
    expect(accepted.awaitingAdmin).toBe(true);
    expect(accepted.executed).toBe(false);
    const approved = env.trades.adminResolve(draftId, view.trade.id, true, ADMIN);
    expect(approved.executed).toBe(true);
  });

  it('executes immediately in auto mode', () => {
    const { draftId, order } = twoPlayersWithTeams({ config: { tradeApproval: 'auto' } });
    const [a, b] = [order[0]!, order[1]!];
    const give = env.trades.resolveAssetRefs(draftId, a.id, [env.engine.getRoster(draftId, a.id).teams[0]!.team.teamNumber]);
    const receive = env.trades.resolveAssetRefs(draftId, b.id, [env.engine.getRoster(draftId, b.id).teams[0]!.team.teamNumber]);
    const { view, events } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    expect(view.trade.status).toBe('executed');
    expect(events.map((e) => e.type)).toEqual(['trade_executed']);
  });

  it('supports 2-for-1 trades only when enabled and respects roster limits', () => {
    const { draftId, order } = twoPlayersWithTeams();
    const [a, b] = [order[0]!, order[1]!];
    const aTeams = env.engine.getRoster(draftId, a.id).teams.map((t) => t.team.teamNumber);
    const bTeams = env.engine.getRoster(draftId, b.id).teams.map((t) => t.team.teamNumber);
    const give = env.trades.resolveAssetRefs(draftId, a.id, aTeams);
    const receive = env.trades.resolveAssetRefs(draftId, b.id, [bTeams[0]!]);
    expect(() => env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN })).toThrow(/2-for-1/);
    env.engine.updateConfig(draftId, { allowTwoForOne: true, maxRosterSize: 4 }, ADMIN);
    // B has 2 teams + 2 pending picks = 4; receiving 2 for 1 would make 5.
    expect(() => env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN })).toThrow(/maximum roster size/);
    env.engine.updateConfig(draftId, { maxRosterSize: null }, ADMIN);
    const { view } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    env.trades.respond(draftId, view.trade.id, true, user(b.users[0]!.discordUserId));
    expect(env.engine.getRoster(draftId, a.id).totalPicks).toBe(1);
    expect(env.engine.getRoster(draftId, b.id).totalPicks).toBe(3);
  });

  it('trades future picks without changing pick numbers, and the new owner picks in that slot', () => {
    const { draftId, order } = twoPlayersWithTeams({ config: { allowFuturePickTrades: true } });
    const [a, b] = [order[0]!, order[1]!];
    // Slots: 1 A, 2 B, 3 B, 4 A, 5 A, 6 B, 7 B, 8 A. Current = 5 (A). B owns 6 and 7 as future picks.
    expect(env.engine.currentTurn(draftId)?.slot.overallPick).toBe(5);
    const aTeam = env.engine.getRoster(draftId, a.id).teams[0]!.team.teamNumber;
    const give = env.trades.resolveAssetRefs(draftId, a.id, [aTeam]);
    const receive = env.trades.resolveAssetRefs(draftId, b.id, ['R3']);
    expect(() => env.trades.resolveAssetRefs(draftId, a.id, ['#5'])).toThrow(/untraded future pick/); // on the clock
    const { view } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    expect(view.receives[0]?.label).toMatch(/Round 3 pick \(#6\)/);
    env.trades.respond(draftId, view.trade.id, true, user(b.users[0]!.discordUserId));
    const slot6 = env.repos.slots.getByOverall(draftId, 6)!;
    expect(slot6.originalParticipantId).toBe(b.id);
    expect(env.repos.assets.getPickAssetForSlot(slot6.id)?.currentParticipantId).toBe(a.id);
    const aRoster = env.engine.getRoster(draftId, a.id);
    expect(aRoster.futurePicks.map((p) => p.overallPick)).toEqual([5, 6, 8]);
    expect(aRoster.futurePicks.find((p) => p.overallPick === 6)?.originalOwner?.id).toBe(b.id);
    // A picks #5, then it is A again for #6 (traded), then B for #7.
    pickNextAvailable(env, draftId);
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(a.id);
    expect(env.engine.currentTurn(draftId)?.slot.overallPick).toBe(6);
    const t = env.repos.teams.listAvailable(draftId, 1)[0]!;
    expect(() => env.engine.pick(draftId, { participantId: b.id, teamId: t.id, actor: user(b.users[0]!.discordUserId) })).toThrow(/can't pick right now/);
    env.engine.pick(draftId, { participantId: a.id, teamId: t.id, actor: user(a.users[0]!.discordUserId) });
    const pick6 = env.repos.picks.listByDraft(draftId).find((p) => p.overallPick === 6)!;
    expect(pick6.participantId).toBe(a.id);
    expect(env.engine.currentTurn(draftId)?.owner.id).toBe(b.id);
    expect(env.engine.getTeamInfo(draftId, t.id).owners[0]?.originalOwner).toBeNull();
  });

  it('blocks illegal trades', () => {
    const { draftId, order } = twoPlayersWithTeams();
    const [a, b] = [order[0]!, order[1]!];
    const aTeam = env.engine.getRoster(draftId, a.id).teams[0]!;
    const bTeam = env.engine.getRoster(draftId, b.id).teams[0]!;
    const propose = (give: number[], receive: number[], actor = ADMIN) =>
      env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor });

    // Not your team.
    expect(() => propose([bTeam.assetId], [aTeam.assetId])).toThrow(/does not belong/);
    // Future picks disabled.
    expect(() => env.trades.resolveAssetRefs(draftId, a.id, ['R4']).length && propose(env.trades.resolveAssetRefs(draftId, a.id, ['R4']), [bTeam.assetId])).toThrow(/future draft picks/);
    // Nonexistent pick.
    expect(() => env.trades.resolveAssetRefs(draftId, a.id, ['R9'])).toThrow(/does not own/);
    // Non-member proposer.
    expect(() => propose([aTeam.assetId], [bTeam.assetId], user('intruder'))).toThrow(/not a member/);
    // Self trade.
    expect(() => env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: a.id, giveAssetIds: [aTeam.assetId], receiveAssetIds: [aTeam.assetId], actor: ADMIN })).toThrow(/yourself/);
    // Empty side.
    expect(() => propose([aTeam.assetId], [])).toThrow(/at least one/);
    // Asset already in a pending trade.
    const first = propose([aTeam.assetId], [bTeam.assetId]);
    expect(() => propose([aTeam.assetId], [bTeam.assetId])).toThrow(/already part of pending trade/);
    // Trades disabled.
    env.engine.updateConfig(draftId, { allowTrades: false }, ADMIN);
    expect(() => env.trades.respond(draftId, first.view.trade.id, true, user(b.users[0]!.discordUserId))).toThrow(/disabled/);
  });

  it('fails safely when an asset changes between proposal and acceptance', () => {
    const { draftId, order } = twoPlayersWithTeams();
    const [a, b] = [order[0]!, order[1]!];
    const aTeam = env.engine.getRoster(draftId, a.id).teams[0]!;
    const bTeam = env.engine.getRoster(draftId, b.id).teams[0]!;
    const { view } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: [aTeam.assetId], receiveAssetIds: [bTeam.assetId], actor: ADMIN });
    // Admin drops A's team before B accepts: the open trade is cancelled by the drop.
    env.engine.adminDropTeam(draftId, a.id, aTeam.team.id, { removeFromPool: false }, ADMIN);
    expect(env.repos.trades.getById(view.trade.id)?.status).toBe('cancelled');
    expect(() => env.trades.respond(draftId, view.trade.id, true, user(b.users[0]!.discordUserId))).toThrow(/cancelled/);
    expect(env.engine.getRoster(draftId, b.id).teams.map((t) => t.assetId)).toContain(bTeam.assetId);
  });

  it('refuses trades after completion unless allowed', () => {
    const { draftId, order } = setupDraft(env, { participants: 2, config: { rounds: 1 }, start: true });
    pickNextAvailable(env, draftId);
    pickNextAvailable(env, draftId);
    expect(env.repos.drafts.getById(draftId)?.status).toBe('completed');
    const [a, b] = [order[0]!, order[1]!];
    const give = [env.engine.getRoster(draftId, a.id).teams[0]!.assetId];
    const receive = [env.engine.getRoster(draftId, b.id).teams[0]!.assetId];
    expect(() => env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN })).toThrow(/complete/);
    env.engine.updateConfig(draftId, { allowTradesAfterCompletion: true }, ADMIN);
    const { view } = env.trades.propose(draftId, { proposerParticipantId: a.id, counterpartyParticipantId: b.id, giveAssetIds: give, receiveAssetIds: receive, actor: ADMIN });
    expect(env.trades.respond(draftId, view.trade.id, true, user(b.users[0]!.discordUserId)).executed).toBe(true);
  });
});
