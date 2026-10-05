import { describe, expect, it } from 'vitest';
import { availableTeamsButtons, availableTeamsEmbed, teamsPageCount } from '../../src/discord/views/teams.js';
import { ADMIN, createTestEnv, pickNextAvailable, setupDraft } from '../helpers/env.js';

describe('/teams view', () => {
  it('renders a grid with copies left and pages', () => {
    const env = createTestEnv();
    const { draftId, teams } = setupDraft(env, { participants: 2, teams: 80, config: { rounds: 1 }, start: true });
    env.engine.setTeamLimit(draftId, teams[1]!.id, 3, ADMIN);
    pickNextAvailable(env, draftId); // takes 1001A
    const draft = env.repos.drafts.getById(draftId)!;
    const available = env.repos.teams.listAvailableWithCounts(draftId, 1);
    expect(available).toHaveLength(79);
    expect(teamsPageCount(available.length, 'grid')).toBe(2);
    const grid = availableTeamsEmbed(draft, available, 80, 0, 'grid', null);
    expect(grid.title).toBe('🤖 Available teams — 79 of 80');
    expect(grid.description).toContain('1002A ×3');
    expect(grid.description).not.toContain('1001A');
    expect(grid.description?.split('\n').length).toBe(14); // fence + 12 rows + fence
    expect(grid.footer).toContain('page 1/2');
    const names = availableTeamsEmbed(draft, available, 80, 0, 'names', null);
    expect(names.description).toContain('`1002A` — **Team 2** · 3 of 3 left');
    expect(availableTeamsButtons(draftId, 0, 2, 'grid').map((b) => b.label)).toEqual(['Previous', 'Next', 'Show names', 'Refresh']);
    const empty = availableTeamsEmbed(draft, [], 80, 0, 'grid', 'zzz');
    expect(empty.description).toContain('No available teams match');
  });
});
