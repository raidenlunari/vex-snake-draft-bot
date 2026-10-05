import { describe, expect, it } from 'vitest';
import { sortTeams } from '../../src/domain/teamOrder.js';
import { ADMIN, createTestEnv, setupDraft } from '../helpers/env.js';
import { buildDraftWorkbook } from '../../src/services/exportWorkbook.js';
import ExcelJS from 'exceljs';

describe('team ordering and export', () => {
  it('orders team numbers numerically like a scoreboard', () => {
    const order = sortTeams(['24816H', '10G', '1010N', '12A', '81Y', '474G', '663A', '2468Y', 'BLRS2', '12S', '12M'].map((teamNumber) => ({ teamNumber }))).map((t) => t.teamNumber);
    expect(order).toEqual(['10G', '12A', '12M', '12S', '81Y', '474G', '663A', '1010N', '2468Y', '24816H', 'BLRS2']);
  });

  it('autocomplete-style listing is natural and prefix-first, and counts overflow', () => {
    const env = createTestEnv();
    const { draftId } = setupDraft(env, { participants: 2, teams: 0, randomize: false });
    for (const n of ['24816H', '10G', '1010N', '12A', '248A', '2481B', '81Y']) env.engine.addTeam(draftId, { teamNumber: n, teamName: null, organization: null, location: null }, ADMIN);
    expect(env.repos.teams.listAvailable(draftId, 1).map((t) => t.teamNumber)).toEqual(['10G', '12A', '81Y', '248A', '1010N', '2481B', '24816H']);
    expect(env.repos.teams.listAvailable(draftId, 1, '248').map((t) => t.teamNumber)).toEqual(['248A', '2481B', '24816H']);
    expect(env.repos.teams.listAvailable(draftId, 1, '1').map((t) => t.teamNumber)).toEqual(['10G', '12A', '1010N', '81Y', '2481B', '24816H']);
    expect(env.repos.teams.countMatching(draftId, '1', true, 1)).toBe(6);
    expect(env.repos.teams.countMatching(draftId, '', false, 1)).toBe(7);
  });

  it('exports an xlsx with Draft, Picks and Teams sheets', async () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 4, config: { rounds: 1 }, start: true });
    const turn = env.engine.currentTurn(draftId)!;
    env.engine.pick(draftId, { participantId: turn.owner.id, teamId: env.repos.teams.getByNumber(draftId, '1001A')!.id, actor: ADMIN });
    const { buffer, filename } = await buildDraftWorkbook(env.engine, env.repos, draftId);
    expect(filename).toMatch(/^test-draft-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Draft', 'Picks', 'Teams']);
    const grid = wb.getWorksheet('Draft')!;
    expect(grid.getCell('A1').value).toBe('Test Draft');
    expect(grid.getCell('A2').value).toBe('Drafter');
    expect(grid.getCell('B3').value).toBe('1001A');
    expect(grid.getCell('A3').value).toBe(order[0]!.label);
    const picks = wb.getWorksheet('Picks')!;
    expect(picks.getCell('D2').value).toBe('1001A');
    const teams = wb.getWorksheet('Teams')!;
    expect(teams.getCell('E2').value).toBe('Drafted');
    expect(teams.getCell('E3').value).toBe('Available');
  });
});
