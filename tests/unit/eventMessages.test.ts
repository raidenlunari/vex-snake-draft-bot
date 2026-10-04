import { describe, expect, it } from 'vitest';
import { defaultDraftConfig } from '../../src/domain/config.js';
import { renderEvents } from '../../src/services/eventMessages.js';
import { ADMIN, createTestEnv, setupDraft, teamByNumber, user } from '../helpers/env.js';

describe('event rendering', () => {
  it('merges a pick with the following turn and pings only the next player', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, config: { skipTimerSeconds: 300 }, start: true });
    const first = order[0]!;
    const events = env.engine.pick(draftId, { participantId: first.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: user(first.users[0]!.discordUserId) });
    const config = { ...defaultDraftConfig(), skipTimerSeconds: 300 };
    const payloads = renderEvents(events, config);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.content).toContain('selected **1001A**');
    expect(payloads[0]?.content).toContain("turn!");
    expect(payloads[0]?.content).toContain('Timer started: 5m');
    expect(payloads[0]?.mentionUserIds).toEqual([order[1]!.users[0]!.discordUserId]);
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
