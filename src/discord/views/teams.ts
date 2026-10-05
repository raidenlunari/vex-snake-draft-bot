import type { Draft, Team } from '../../domain/types.js';
import { Colors, type ButtonSpec, type EmbedPayload } from '../../services/announcer.js';
import { customId } from '../context.js';

export type TeamsMode = 'grid' | 'names';
export interface AvailableTeam extends Team {
  used: number;
  limit: number;
}

const GRID_COLUMNS = 6;
const GRID_ROWS_PER_PAGE = 12; // 72 teams per page
const NAMES_PER_PAGE = 20;

export function teamsPageCount(total: number, mode: TeamsMode): number {
  const per = mode === 'grid' ? GRID_COLUMNS * GRID_ROWS_PER_PAGE : NAMES_PER_PAGE;
  return Math.max(1, Math.ceil(total / per));
}

/**
 * Renders the pool of teams still available. Grid mode mirrors the club's tracking
 * sheet (numbers in aligned columns); names mode lists number, name and school.
 */
export function availableTeamsEmbed(draft: Draft, teams: AvailableTeam[], totalTeams: number, page: number, mode: TeamsMode, filter: string | null): EmbedPayload {
  const pages = teamsPageCount(teams.length, mode);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const per = mode === 'grid' ? GRID_COLUMNS * GRID_ROWS_PER_PAGE : NAMES_PER_PAGE;
  const slice = teams.slice(current * per, (current + 1) * per);
  let description: string;
  if (teams.length === 0) {
    description = filter ? `_No available teams match "${filter}"._` : '_Every team has been drafted._';
  } else if (mode === 'grid') {
    const width = Math.max(...slice.map((t) => t.teamNumber.length + (t.limit > 1 ? 4 : 0)), 5);
    const cell = (t: AvailableTeam): string => {
      const text = t.limit > 1 ? `${t.teamNumber} ×${t.limit - t.used}` : t.teamNumber;
      return text.padEnd(width);
    };
    const lines: string[] = [];
    for (let i = 0; i < slice.length; i += GRID_COLUMNS) lines.push(slice.slice(i, i + GRID_COLUMNS).map(cell).join('  ').trimEnd());
    description = '```\n' + lines.join('\n') + '\n```';
  } else {
    description = slice
      .map((t) => {
        const name = t.teamName ? ` — **${t.teamName}**` : '';
        const org = t.organization ? ` · ${t.organization}` : '';
        const loc = t.location ? ` · ${t.location}` : '';
        const copies = t.limit > 1 ? ` · ${t.limit - t.used} of ${t.limit} left` : '';
        return `\`${t.teamNumber}\`${name}${org}${loc}${copies}`;
      })
      .join('\n');
  }
  const drafted = totalTeams - teams.length;
  return {
    title: `🤖 Available teams — ${teams.length} of ${totalTeams}`,
    description,
    color: teams.length ? Colors.success : Colors.neutral,
    footer: `${drafted} drafted${filter ? ` · filter "${filter}"` : ''} · page ${current + 1}/${pages} · ${mode === 'grid' ? '×n = copies left' : 'use /team <number> for details'}`,
  };
}

export function availableTeamsButtons(draftId: number, page: number, pages: number, mode: TeamsMode): ButtonSpec[] {
  const other: TeamsMode = mode === 'grid' ? 'names' : 'grid';
  // Every button needs a distinct custom id, so prev/next carry the action name "prev"/"next"
  // and refresh/toggle carry their own; the handler only reads the page number and mode.
  const buttons: ButtonSpec[] = [];
  if (pages > 1) {
    buttons.push({ id: customId('teams', 'prev', draftId, Math.max(0, page - 1), mode), label: 'Previous', style: 'secondary', emoji: '◀️' });
    buttons.push({ id: customId('teams', 'next', draftId, Math.min(pages - 1, page + 1), mode), label: 'Next', style: 'secondary', emoji: '▶️' });
  }
  buttons.push({ id: customId('teams', 'mode', draftId, 0, other), label: other === 'names' ? 'Show names' : 'Show grid', style: 'primary', emoji: other === 'names' ? '📝' : '🔢' });
  buttons.push({ id: customId('teams', 'refresh', draftId, page, mode), label: 'Refresh', style: 'secondary', emoji: '🔄' });
  return buttons;
}
