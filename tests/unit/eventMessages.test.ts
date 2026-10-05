import { describe, expect, it } from 'vitest';
import { defaultDraftConfig } from '../../src/domain/config.js';
import { renderEvents } from '../../src/services/eventMessages.js';
import { ADMIN, createTestEnv, setupDraft, teamByNumber, user } from '../helpers/env.js';

describe('event rendering', () => {
  it('lists up, on deck, in the hole, 4th and 5th with mentions only for the first three', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 6, config: { rounds: 2 }, start: true });
    const first = order[0]!;
    const events = env.engine.pick(draftId, { participantId: first.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: ADMIN });
    const [payload] = renderEvents(events, defaultDraftConfig());
    const u = (i: number) => order[i]!.users[0]!.discordUserId;
    expect(payload?.content).toBe(
      [`${first.label} picked **1001A**.`, `<@${u(1)}> is up.`, `<@${u(2)}> is on deck.`, `<@${u(3)}> is in the hole.`, `${order[4]!.label} is 4th.`, `${order[5]!.label} is 5th.`].join('\n'),
    );
    expect(payload?.mentionUserIds).toEqual([u(1), u(2), u(3)]);
  });

  it('merges a pick with the following turn and pings only the next player', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, config: { skipTimerSeconds: 300 }, start: true });
    const first = order[0]!;
    const events = env.engine.pick(draftId, { participantId: first.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: user(first.users[0]!.discordUserId) });
    const config = { ...defaultDraftConfig(), skipTimerSeconds: 300 };
    const payloads = renderEvents(events, config);
    expect(payloads).toHaveLength(1);
    const lines = payloads[0]!.content!.split('\n');
    expect(lines[0]).toBe(`${first.label} picked **1001A**.`);
    expect(lines[1]).toBe(`<@${order[1]!.users[0]!.discordUserId}> is up.`);
    expect(lines[2]).toBe(`<@${first.users[0]!.discordUserId}> is on deck.`);
    // two players, snake order: picks 2,3 are B, 4,5 are A, 6 is B -> B is also "in the hole"
    expect(lines[3]).toBe(`<@${order[1]!.users[0]!.discordUserId}> is in the hole.`);
    expect(lines[4]).toMatch(/^Auto-skip <t:\d+:R>\.$/);
    expect(payloads[0]?.mentionUserIds).toEqual([order[1]!.users[0]!.discordUserId, first.users[0]!.discordUserId, order[1]!.users[0]!.discordUserId]);
  });

  it('renders skips, completion and corrections', () => {
    const env = createTestEnv();
    const { draftId } = setupDraft(env, { participants: 2, config: { rounds: 1 }, start: true });
    const skip = renderEvents(env.engine.skipCurrent(draftId, ADMIN), defaultDraftConfig());
    expect(skip[0]?.content).toContain('skipped');
    expect(skip[0]?.content).toContain('can still use');
    const done = renderEvents(env.engine.skipCurrent(draftId, ADMIN), defaultDraftConfig());
    expect(done.some((p) => p.content?.includes('draft is complete'))).toBe(true);
  });
});
