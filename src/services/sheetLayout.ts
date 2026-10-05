import { a1Range, type RangeValues } from '../integrations/googleSheets.js';

/**
 * Fills a user-made sheet in place. The sheet is expected to contain a header cell
 * "Drafter" with "Pick 1", "Pick 2", … to its right and drafter names below it, and
 * optionally a cell "Available Teams" with free space below it. Only values are written;
 * formatting, borders and notes stay as they are.
 */
export interface LayoutDraftRow {
  label: string;
  picks: string[];
}

export interface LayoutInput {
  existing: string[][];
  drafters: LayoutDraftRow[];
  availableTeams: string[];
  picksPerSeat: number;
  /** Lines written to the right of the "Available Teams" header area, e.g. status. */
  notes?: Array<[string, string]>;
}

export interface LayoutPlan {
  writes: RangeValues[];
  clears: string[];
  unmatched: string[];
}

const AVAILABLE_COLUMNS = 7;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cell(existing: string[][], r: number, c: number): string {
  return existing[r]?.[c] ?? '';
}

function findCell(existing: string[][], predicate: (v: string) => boolean): { row: number; col: number } | null {
  for (let r = 0; r < existing.length; r++) {
    const row = existing[r] ?? [];
    for (let c = 0; c < row.length; c++) if (predicate(norm(row[c] ?? ''))) return { row: r, col: c };
  }
  return null;
}

/** Whether the sheet has the expected headers. */
export function detectLayout(existing: string[][]): boolean {
  return findCell(existing, (v) => v === 'drafter') !== null;
}

export function planLayoutFill(input: LayoutInput): LayoutPlan {
  const { existing } = input;
  const header = findCell(existing, (v) => v === 'drafter');
  if (!header) throw new Error('No "Drafter" header cell found');
  const headerRow = existing[header.row] ?? [];

  // Pick columns: cells to the right of "Drafter" whose header starts with "pick"; if none, assume picksPerSeat columns.
  let pickCols: number[] = [];
  for (let c = header.col + 1; c < Math.max(headerRow.length, header.col + 1); c++) {
    if (norm(headerRow[c] ?? '').startsWith('pick')) pickCols.push(c);
  }
  const needed = Math.max(input.picksPerSeat, ...input.drafters.map((d) => d.picks.length), 1);
  if (pickCols.length === 0) pickCols = Array.from({ length: needed }, (_, i) => header.col + 1 + i);
  while (pickCols.length < needed) pickCols.push((pickCols[pickCols.length - 1] as number) + 1);

  // Drafter rows: contiguous non-empty cells under the header.
  const rows = new Map<string, number>();
  let r = header.row + 1;
  while (r < existing.length && cell(existing, r, header.col).trim() !== '') {
    rows.set(norm(cell(existing, r, header.col)), r);
    r += 1;
  }
  let nextFreeRow = r;
  const unmatched: string[] = [];
  const writes: RangeValues[] = [];

  const rowFor = (label: string): number => {
    const key = norm(label);
    const exact = rows.get(key);
    if (exact !== undefined) return exact;
    for (const [k, row] of rows) if (k.includes(key) || key.includes(k)) return row;
    // Append below the existing block.
    const row = nextFreeRow++;
    rows.set(key, row);
    unmatched.push(label);
    writes.push({ range: a1Range(row, header.col, 1, 1), values: [[label]] });
    return row;
  };

  const first = pickCols[0] as number;
  const last = pickCols[pickCols.length - 1] as number;
  const contiguous = last - first + 1 === pickCols.length;
  for (const d of input.drafters) {
    const row = rowFor(d.label);
    const cells = pickCols.map((_, i) => d.picks[i] ?? '');
    if (contiguous) writes.push({ range: a1Range(row, first, 1, pickCols.length), values: [cells] });
    else pickCols.forEach((c, i) => writes.push({ range: a1Range(row, c, 1, 1), values: [[cells[i] ?? '']] }));
  }

  const clears: string[] = [];
  const avail = findCell(existing, (v) => v.startsWith('available teams'));
  if (avail) {
    const grid: string[][] = [];
    for (let i = 0; i < input.availableTeams.length; i += AVAILABLE_COLUMNS) {
      const row = input.availableTeams.slice(i, i + AVAILABLE_COLUMNS);
      while (row.length < AVAILABLE_COLUMNS) row.push('');
      grid.push(row);
    }
    // Clear what was there before (grow the cleared area to cover any earlier, larger grid).
    let oldRows = 0;
    for (let rr = avail.row + 1; rr < existing.length; rr++) {
      const line = existing[rr] ?? [];
      const slice = line.slice(avail.col, avail.col + AVAILABLE_COLUMNS);
      if (slice.every((v) => (v ?? '').trim() === '')) break;
      oldRows += 1;
    }
    const height = Math.max(oldRows, grid.length, 1);
    clears.push(a1Range(avail.row + 1, avail.col, height, AVAILABLE_COLUMNS));
    if (grid.length) writes.push({ range: a1Range(avail.row + 1, avail.col, grid.length, AVAILABLE_COLUMNS), values: grid });
    writes.push({ range: a1Range(avail.row, avail.col, 1, 1), values: [[`Available Teams (${input.availableTeams.length})`]] });
  }

  // Optional notes: fill "Picks per team"-style label cells if present.
  for (const [label, value] of input.notes ?? []) {
    const found = findCell(existing, (v) => v === norm(label));
    if (found) writes.push({ range: a1Range(found.row, found.col + 1, 1, 1), values: [[value]] });
  }
  return { writes, clears, unmatched };
}
