import { describe, expect, it } from 'vitest';
import type { RangeValues, SheetsClient } from '../../src/integrations/googleSheets.js';
import { parseSpreadsheetId, tabRange } from '../../src/integrations/googleSheets.js';
import { silentLogger } from '../../src/logging/logger.js';
import { renderDraftSheet, SheetSyncService } from '../../src/services/sheetSync.js';
import { ADMIN, createTestEnv, pickNextAvailable, setupDraft, teamByNumber, user } from '../helpers/env.js';

class FakeSheets implements SheetsClient {
  serviceAccountEmail = 'bot@test.iam.gserviceaccount.com';
  writes: Array<{ spreadsheetId: string; tab: string; values: string[][] }> = [];
  fail = false;
  async writeTab(spreadsheetId: string, tab: string, values: string[][]): Promise<void> {
    if (this.fail) throw new Error('boom');
    this.writes.push({ spreadsheetId, tab, values });
  }
  async describe(): Promise<{ title: string; tabs: string[] }> {
    return { title: 'Smoky Mountain', tabs: ['Draft'] };
  }
  existing: string[][] = [];
  ranges: Array<{ writes: RangeValues[]; clears: string[] }> = [];
  async readTab(): Promise<string[][]> {
    return this.existing;
  }
  async updateRanges(_id: string, _tab: string, writes: RangeValues[], clears: string[]): Promise<void> {
    if (this.fail) throw new Error('boom');
    this.ranges.push({ writes, clears });
  }
}

describe('Google Sheets mirror', () => {
  it('renders the draft in the club sheet layout', () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 3, teams: 10, config: { rounds: 2 }, start: true });
    pickNextAvailable(env, draftId);
    const a = order[0]!;
    env.engine.adminAddTeam(draftId, a.id, teamByNumber(env, draftId, '1009A').id, ADMIN);
    const rows = renderDraftSheet(env.engine, env.repos, draftId);
    expect(rows[0]).toEqual(['Test Draft']);
    expect(rows[1]).toEqual(['Drafter', 'Pick 1', 'Pick 2']);
    expect(rows[2]).toEqual([a.label, '1001A', '1009A']);
    expect(rows[3]).toEqual([order[1]!.label, '', '']);
    expect(rows[5]).toEqual([]);
    expect(rows[6]?.[0]).toBe('Available Teams (8)');
    expect(rows[7]?.slice(0, 7)).toEqual(['1002A', '1003A', '1004A', '1005A', '1006A', '1007A', '1008A']);
    expect(rows[7]?.slice(8)).toEqual(['Picks per team', '2']);
    expect(rows[8]?.slice(8)).toEqual(['Status', expect.stringContaining('Round 1 · Pick #2 of 6')]);
  });

  it('writes after changes via the service, debounced, and reports errors without breaking the draft', async () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 5, config: { rounds: 1 }, start: true });
    const fake = new FakeSheets();
    const sync = new SheetSyncService({ client: fake, repos: env.repos, engine: env.engine, logger: silentLogger, debounceMs: 5 });
    sync.schedule(draftId); // no sheet linked yet
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.writes).toHaveLength(0);
    env.engine.setSheet(draftId, { spreadsheetId: 'abc123', tab: 'Draft' }, ADMIN);
    sync.schedule(draftId);
    sync.schedule(draftId);
    sync.schedule(draftId);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({ spreadsheetId: 'abc123', tab: 'Draft' });
    env.engine.pick(draftId, { participantId: order[0]!.id, teamId: teamByNumber(env, draftId, '1001A').id, actor: user(order[0]!.users[0]!.discordUserId) });
    await sync.syncNow(draftId);
    expect(fake.writes[1]?.values[2]).toContain('1001A');
    fake.fail = true;
    await expect(sync.syncNow(draftId)).rejects.toThrow('boom');
    expect(sync.lastError.get(draftId)).toBe('boom');
    expect(env.repos.audit.listByType(draftId, 'sheet_changed')).toHaveLength(1);
    sync.stop();
  });

  it('fills a user layout in place when the tab has a Drafter header', async () => {
    const env = createTestEnv();
    const { draftId, order } = setupDraft(env, { participants: 2, teams: 5, config: { rounds: 1 }, start: true });
    pickNextAvailable(env, draftId);
    const fake = new FakeSheets();
    fake.existing = [['Drafter', 'Pick 1'], [order[0]!.label], [order[1]!.label], [], ['Available Teams']];
    const sync = new SheetSyncService({ client: fake, repos: env.repos, engine: env.engine, logger: silentLogger, debounceMs: 5 });
    env.engine.setSheet(draftId, { spreadsheetId: 'abc', tab: 'Sheet1' }, ADMIN);
    await sync.syncNow(draftId);
    expect(fake.writes).toHaveLength(0); // no full rewrite
    const plan = fake.ranges[0]!;
    expect(plan.writes.find((w) => w.range === 'B2:B2')?.values).toEqual([['1001A']]);
    expect(plan.writes.find((w) => w.range === 'A6:G6')?.values[0]).toEqual(['1002A', '1003A', '1004A', '1005A', '', '', '']);
    expect(sync.lastUnmatched.get(draftId)).toEqual([]);
  });

  it('parses spreadsheet ids and quotes tab names', () => {
    expect(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC_dEf-123456789012345/edit#gid=0')).toBe('1AbC_dEf-123456789012345');
    expect(parseSpreadsheetId('1AbC_dEf-123456789012345')).toBe('1AbC_dEf-123456789012345');
    expect(parseSpreadsheetId('nope')).toBeNull();
    expect(tabRange("Smoky's Draft")).toBe("'Smoky''s Draft'");
  });
});
