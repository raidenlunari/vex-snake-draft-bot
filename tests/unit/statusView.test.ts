import { describe, expect, it } from 'vitest';
import { statusEmbed } from '../../src/discord/views/index.js';
import { ADMIN, createTestEnv, pickNextAvailable, setupDraft } from '../helpers/env.js';

describe('/status view', () => {
  it('renders a sheet-style grid with the current drafter marked and skips shown', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 3, teams: 20, config: { rounds: 2, skipTimerSeconds: 600 }, start: true });
    pickNextAvailable(env, draftId);
    env.engine.skipCurrent(draftId, ADMIN);
    const embed = statusEmbed(env.engine.getState(draftId), env.clock.nowIso());
    const text = embed.description!;
    expect(text).toContain('**Round 1 / 2** · Pick **#3** of 6 · 19 teams left');
    expect(text).toContain(`▶ <@${order[2]!.users[0]!.discordUserId}> is up · auto-skip <t:`);
    const grid = text.slice(text.indexOf('```') + 4, text.lastIndexOf('```'));
    const rows = grid.trim().split('\n');
    expect(rows[0]).toMatch(/^Drafter\s+P1\s+P2/);
    expect(rows[1]).toMatch(new RegExp(`^  ${order[0]!.label}\\s+1001A`));
    expect(rows[2]).toMatch(new RegExp(`^  ${order[1]!.label}\\s+skip`));
    expect(rows[3]).toMatch(new RegExp(`^▶ ${order[2]!.label}`));
    expect(text).toContain('"skip" = open catch-up pick');

  });
});
