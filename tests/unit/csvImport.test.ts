import { describe, expect, it } from 'vitest';
import { parseTeamsCsv } from '../../src/engine/csvImport.js';
import { ADMIN, createTestEnv, setupDraft } from '../helpers/env.js';

describe('CSV parsing', () => {
  it('detects common headers and normalizes team numbers', () => {
    const csv = 'Team Number,Team Name,Organization,City,State\n1234a,Robo Lions,Lincoln High,Austin,TX\n 5678B ,Byte Me,,Dallas,\n';
    const r = parseTeamsCsv(csv);
    expect(r.headerDetected).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ teamNumber: '1234A', teamName: 'Robo Lions', organization: 'Lincoln High', location: 'Austin, TX' });
    expect(r.rows[1]).toMatchObject({ teamNumber: '5678B', teamName: 'Byte Me', organization: null, location: 'Dallas' });
  });

  it('handles headerless files, BOMs and extra columns', () => {
    const r = parseTeamsCsv('﻿99999,Test Team,Some School,Nowhere\n');
    expect(r.headerDetected).toBe(false);
    expect(r.rows[0]).toMatchObject({ teamNumber: '99999', teamName: 'Test Team', organization: 'Some School', location: 'Nowhere' });
    const r2 = parseTeamsCsv('number,name,grade,robot_weight\n1A,One,Middle School,12\n');
    expect(r2.columns.extra).toEqual(['grade', 'robot_weight']);
    expect(r2.rows[0]?.extra).toEqual({ grade: 'Middle School', robot_weight: '12' });
  });

  it('reports invalid, missing and duplicate numbers', () => {
    const csv = 'team,name\n1234A,Good\n,No Number\n12 34!,Bad Chars\n1234A,Dup\n';
    const r = parseTeamsCsv(csv);
    expect(r.rows.map((x) => x.teamNumber)).toEqual(['1234A']);
    expect(r.failed.map((f) => f.reason)).toEqual(['missing team number', 'invalid team number "12 34!"']);
    expect(r.duplicates).toEqual([{ line: 5, teamNumber: '1234A', firstLine: 2 }]);
  });

  it('rejects malformed or empty csv', () => {
    expect(() => parseTeamsCsv('')).toThrow(/empty/);
    expect(() => parseTeamsCsv('a,"b\n1,2')).toThrow(/could not be parsed/);
  });
});

describe('CSV import into a draft', () => {
  it('imports, updates, skips and reports', () => {
    const env = createTestEnv();
    const { draftId } = setupDraft(env, { participants: 2, teams: 0, randomize: false });
    const first = env.importer.importTeams(draftId, 'number,name,org\n1A,Alpha,School A\n2B,Beta,School B\n', ADMIN);
    expect(first.imported).toEqual(['1A', '2B']);
    const second = env.importer.importTeams(draftId, 'number,name,org\n1A,Alpha Prime,School A\n2B,Beta,School B\n3C,Gamma,\nbad!,X,\n', ADMIN);
    expect(second.updated).toEqual(['1A']);
    expect(second.skipped).toEqual([{ teamNumber: '2B', reason: 'already in the draft, unchanged' }]);
    expect(second.imported).toEqual(['3C']);
    expect(second.failed).toHaveLength(1);
    expect(env.repos.teams.getByNumber(draftId, '1A')?.teamName).toBe('Alpha Prime');
    const third = env.importer.importTeams(draftId, 'number,name\n1A,Changed Again\n', ADMIN, 'skip-existing');
    expect(third.skipped[0]?.reason).toBe('already in the draft');
    expect(env.repos.teams.getByNumber(draftId, '1A')?.teamName).toBe('Alpha Prime');
    const removed = env.repos.teams.getByNumber(draftId, '3C')!;
    env.engine.removeTeam(draftId, removed.id, { force: false }, ADMIN);
    const fourth = env.importer.importTeams(draftId, 'number\n3C\n', ADMIN);
    expect(fourth.skipped[0]?.reason).toMatch(/removed/);
    expect(env.repos.audit.listByType(draftId, 'teams_imported')).toHaveLength(4);
  });
});
