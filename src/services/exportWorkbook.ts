import ExcelJS from 'exceljs';
import type { Repositories } from '../db/repositories/index.js';
import type { Team } from '../domain/types.js';
import type { DraftEngine } from '../engine/draftEngine.js';
import { sortTeams } from '../domain/teamOrder.js';
import { renderDraftSheet } from './sheetSync.js';

/**
 * Builds an .xlsx snapshot of the draft: the sheet-style grid, the pick log, and every
 * team with its status. Same content as the Google Sheet mirror, as a file.
 */
export async function buildDraftWorkbook(engine: DraftEngine, repos: Repositories, draftId: number): Promise<{ buffer: Buffer; filename: string }> {
  const state = engine.getState(draftId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VEX Snake Draft Bot';
  wb.created = new Date();

  const grid = wb.addWorksheet('Draft');
  for (const row of renderDraftSheet(engine, repos, draftId)) grid.addRow(row);
  grid.getRow(1).font = { name: 'Arial', bold: true, size: 14 };
  grid.getRow(2).font = { name: 'Arial', bold: true };
  grid.getColumn(1).width = 28;
  for (let c = 2; c <= Math.max(grid.columnCount, 2); c++) grid.getColumn(c).width = 10;
  grid.eachRow((row) => row.eachCell((cell) => { if (!cell.font) cell.font = { name: 'Arial' }; }));

  const picks = wb.addWorksheet('Picks');
  picks.addRow(['Overall pick', 'Round', 'Drafter', 'Team', 'Team name', 'Organization', 'How', 'When (UTC)']).font = { name: 'Arial', bold: true };
  const participants = new Map(state.participants.map((p) => [p.id, p]));
  for (const pick of repos.picks.listByDraft(draftId)) {
    const team = repos.teams.getById(pick.teamId) as Team;
    picks.addRow([pick.overallPick ?? '', pick.round ?? '', participants.get(pick.participantId)?.label ?? '', team.teamNumber, team.teamName ?? '', team.organization ?? '', pick.kind, pick.madeAt.replace('T', ' ').slice(0, 19)]);
  }
  picks.columns.forEach((col, i) => { col.width = [12, 8, 28, 10, 28, 32, 12, 20][i] ?? 12; col.font = { name: 'Arial' }; });
  picks.getRow(1).font = { name: 'Arial', bold: true };

  const teams = wb.addWorksheet('Teams');
  teams.addRow(['Team', 'Name', 'Organization', 'Location', 'Status', 'Drafter', 'Pick']).font = { name: 'Arial', bold: true };
  for (const team of sortTeams(repos.teams.listByDraft(draftId, { includeRemoved: true }))) {
    const owners = repos.assets.listActiveForTeam(team.id);
    if (owners.length === 0) {
      teams.addRow([team.teamNumber, team.teamName ?? '', team.organization ?? '', team.location ?? '', team.removedAt ? 'Removed' : 'Available', '', '']);
      continue;
    }
    for (const o of owners) {
      teams.addRow([team.teamNumber, team.teamName ?? '', team.organization ?? '', team.location ?? '', 'Drafted', participants.get(o.currentParticipantId)?.label ?? '', o.overallPick ?? '']);
    }
  }
  teams.columns.forEach((col, i) => { col.width = [10, 28, 32, 26, 11, 28, 8][i] ?? 12; col.font = { name: 'Arial' }; });
  teams.getRow(1).font = { name: 'Arial', bold: true };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const safe = state.draft.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'draft';
  return { buffer, filename: `${safe}-${new Date().toISOString().slice(0, 10)}.xlsx` };
}
