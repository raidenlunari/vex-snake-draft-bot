import { parse } from 'csv-parse/sync';
import { inTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories/index.js';
import { DraftError } from '../domain/errors.js';
import type { Actor } from '../domain/types.js';
import type { Clock } from '../util/clock.js';
import { loadContext, requireStatus } from './context.js';
import { isValidTeamNumber, normalizeTeamNumber } from './draftEngine.js';

export interface ParsedTeamRow {
  line: number;
  teamNumber: string;
  teamName: string | null;
  organization: string | null;
  location: string | null;
  extra: Record<string, string> | null;
}

export interface ParseResult {
  rows: ParsedTeamRow[];
  failed: Array<{ line: number; reason: string; raw: string }>;
  duplicates: Array<{ line: number; teamNumber: string; firstLine: number }>;
  columns: { teamNumber: string; teamName: string | null; organization: string | null; location: string | null; extra: string[] };
  headerDetected: boolean;
}

export interface ImportSummary {
  imported: string[];
  updated: string[];
  skipped: Array<{ teamNumber: string; reason: string }>;
  failed: Array<{ line: number; reason: string; raw: string }>;
  duplicates: Array<{ line: number; teamNumber: string; firstLine: number }>;
  totalRows: number;
}

export type ImportMode = 'merge' | 'skip-existing';

const NUMBER_HEADERS = ['teamnumber', 'number', 'team', 'teamno', 'teamnum', 'team#', 'num', 'id', 'teamid', 'teamcode', 'code'];
const NAME_HEADERS = ['teamname', 'name', 'robotname', 'nickname', 'robot', 'alias'];
const ORG_HEADERS = ['organization', 'organisation', 'org', 'school', 'affiliation', 'teamorg', 'club', 'sponsor', 'programorg'];
const LOCATION_HEADERS = ['location', 'citystate', 'hometown', 'cityregion', 'place', 'cityst'];
const CITY_HEADERS = ['city', 'town'];
const REGION_HEADERS = ['state', 'region', 'province', 'stateprovince'];
const COUNTRY_HEADERS = ['country'];

const MAX_CSV_BYTES = 2 * 1024 * 1024;

function norm(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9#]/g, '');
}

function pickColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map((h) => [h, norm(h)] as const);
  for (const c of candidates) {
    const hit = normalized.find(([, n]) => n === c);
    if (hit) return hit[0];
  }
  return null;
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/**
 * Parses CSV text into team rows. Detects columns from the header row; if the first
 * row has no recognizable header, treats the file as headerless with the column order
 * number, name, organization, location.
 */
export function parseTeamsCsv(text: string): ParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) throw new DraftError('VALIDATION', 'The CSV is larger than 2 MB.');
  const content = text.replace(/^\uFEFF/, '');
  let records: string[][];
  try {
    records = parse(content, { relax_column_count: true, skip_empty_lines: true, trim: true, bom: true, relax_quotes: true }) as string[][];
  } catch (err) {
    throw new DraftError('VALIDATION', `The CSV could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (records.length === 0) throw new DraftError('VALIDATION', 'The CSV is empty.');

  const first = records[0] as string[];
  const numberCol = pickColumn(first, NUMBER_HEADERS);
  const headerDetected = numberCol !== null || (first.length > 1 && !isValidTeamNumber(normalizeTeamNumber(first[0] ?? '')) && first.some((h) => NAME_HEADERS.includes(norm(h)) || ORG_HEADERS.includes(norm(h))));

  let headers: string[];
  let dataStart: number;
  if (headerDetected) {
    headers = first.map((h, i) => (h && h.trim()) || `column${i + 1}`);
    dataStart = 1;
  } else {
    headers = ['Team Number', 'Team Name', 'Organization', 'Location'];
    dataStart = 0;
  }
  const columns = {
    teamNumber: headerDetected ? (numberCol ?? (headers[0] as string)) : 'Team Number',
    teamName: headerDetected ? pickColumn(headers, NAME_HEADERS) : 'Team Name',
    organization: headerDetected ? pickColumn(headers, ORG_HEADERS) : 'Organization',
    location: headerDetected ? pickColumn(headers, LOCATION_HEADERS) : 'Location',
    extra: [] as string[],
  };
  const cityCol = headerDetected ? pickColumn(headers, CITY_HEADERS) : null;
  const regionCol = headerDetected ? pickColumn(headers, REGION_HEADERS) : null;
  const countryCol = headerDetected ? pickColumn(headers, COUNTRY_HEADERS) : null;
  const known = new Set([columns.teamNumber, columns.teamName, columns.organization, columns.location, cityCol, regionCol, countryCol].filter(Boolean) as string[]);
  columns.extra = headers.filter((h) => !known.has(h));

  const rows: ParsedTeamRow[] = [];
  const failed: ParseResult['failed'] = [];
  const duplicates: ParseResult['duplicates'] = [];
  const seen = new Map<string, number>();
  const idx = (name: string | null): number => (name === null ? -1 : headers.indexOf(name));

  for (let i = dataStart; i < records.length; i++) {
    const record = records[i] as string[];
    const line = i + 1;
    const raw = record.join(',');
    const rawNumber = clean(record[idx(columns.teamNumber)]);
    if (!rawNumber) {
      failed.push({ line, reason: 'missing team number', raw });
      continue;
    }
    const teamNumber = normalizeTeamNumber(rawNumber);
    if (!isValidTeamNumber(teamNumber)) {
      failed.push({ line, reason: `invalid team number "${rawNumber}"`, raw });
      continue;
    }
    const firstLine = seen.get(teamNumber);
    if (firstLine !== undefined) {
      duplicates.push({ line, teamNumber, firstLine });
      continue;
    }
    seen.set(teamNumber, line);
    let location = clean(record[idx(columns.location)]);
    if (!location && (cityCol || regionCol || countryCol)) {
      location = [clean(record[idx(cityCol)]), clean(record[idx(regionCol)]), clean(record[idx(countryCol)])].filter(Boolean).join(', ') || null;
    }
    const extra: Record<string, string> = {};
    for (const col of columns.extra) {
      const v = clean(record[idx(col)]);
      if (v) extra[col] = v;
    }
    rows.push({
      line,
      teamNumber,
      teamName: clean(record[idx(columns.teamName)]),
      organization: clean(record[idx(columns.organization)]),
      location,
      extra: Object.keys(extra).length ? extra : null,
    });
  }
  return { rows, failed, duplicates, columns, headerDetected };
}

export class CsvImporter {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
  ) {}

  importTeams(draftId: number, csvText: string, actor: Actor, mode: ImportMode = 'merge'): ImportSummary {
    const parsed = parseTeamsCsv(csvText);
    return inTransaction(this.repos.db, () => {
      const ctx = loadContext(this.repos, draftId);
      requireStatus(ctx, ['setup', 'randomized', 'active'], 'Importing teams');
      const now = this.clock.nowIso();
      const summary: ImportSummary = { imported: [], updated: [], skipped: [], failed: parsed.failed, duplicates: parsed.duplicates, totalRows: parsed.rows.length + parsed.failed.length + parsed.duplicates.length };
      for (const row of parsed.rows) {
        const existing = this.repos.teams.getByNumber(draftId, row.teamNumber);
        if (!existing) {
          this.repos.teams.create(draftId, { teamNumber: row.teamNumber, teamName: row.teamName, organization: row.organization, location: row.location, extra: row.extra }, now);
          summary.imported.push(row.teamNumber);
          continue;
        }
        if (existing.removedAt) {
          summary.skipped.push({ teamNumber: row.teamNumber, reason: 'removed from this draft (use /draft team restore)' });
          continue;
        }
        if (mode === 'skip-existing') {
          summary.skipped.push({ teamNumber: row.teamNumber, reason: 'already in the draft' });
          continue;
        }
        const changed =
          (row.teamName ?? existing.teamName) !== existing.teamName ||
          (row.organization ?? existing.organization) !== existing.organization ||
          (row.location ?? existing.location) !== existing.location ||
          (row.extra !== null && JSON.stringify(row.extra) !== JSON.stringify(existing.extra));
        if (!changed) {
          summary.skipped.push({ teamNumber: row.teamNumber, reason: 'already in the draft, unchanged' });
          continue;
        }
        this.repos.teams.update(
          existing.id,
          {
            teamName: row.teamName ?? existing.teamName,
            organization: row.organization ?? existing.organization,
            location: row.location ?? existing.location,
            extra: row.extra ?? existing.extra,
          },
          now,
        );
        summary.updated.push(row.teamNumber);
      }
      this.repos.audit.record({
        guildId: ctx.draft.guildId,
        draftId,
        eventType: 'teams_imported',
        actor,
        summary: `CSV import: ${summary.imported.length} imported, ${summary.updated.length} updated, ${summary.skipped.length} skipped, ${summary.failed.length} failed, ${summary.duplicates.length} duplicates`,
        subject: { mode, columns: parsed.columns, headerDetected: parsed.headerDetected },
        after: { imported: summary.imported, updated: summary.updated },
        now,
      });
      return summary;
    });
  }
}
