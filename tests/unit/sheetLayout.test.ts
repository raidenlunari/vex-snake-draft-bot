import { describe, expect, it } from 'vitest';
import { a1Range, columnLetter } from '../../src/integrations/googleSheets.js';
import { detectLayout, planLayoutFill } from '../../src/services/sheetLayout.js';

const sheet: string[][] = [
  [],
  ['', 'Smoky Mountain'],
  ['', 'Drafter', 'Pick 1', 'Pick 2', 'Pick 3', 'Pick 4', ''],
  ['', 'moon'],
  ['', 'andrew + joseph + hinata 1727'],
  ['', 'Mason | no team  + eli9821c'],
  ['', 'Jacob | 1723A'],
  [],
  ['', '', '', '', '', 'Skips to be enforced with discretion'],
  ['', 'Available Teams', '', '', '', 'Picks per team', '2'],
  ['', '10G', '12A', '12M', '12S', '81Y', '88S', '474G'],
  ['', '663A', '663D'],
];

describe('sheet layout fill', () => {
  it('maps A1 ranges', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(26)).toBe('AA');
    expect(a1Range(3, 2, 1, 4)).toBe('C4:F4');
  });

  it('detects the Drafter header', () => {
    expect(detectLayout(sheet)).toBe(true);
    expect(detectLayout([['Team', 'Name']])).toBe(false);
  });

  it('writes picks beside matching drafters, appends unknown ones, refreshes the available grid', () => {
    const plan = planLayoutFill({
      existing: sheet,
      drafters: [
        { label: 'moon', picks: ['4873G', '2145V'] },
        { label: 'Mason | no team + eli9821c', picks: ['12A'] },
        { label: 'Jacob | 1723A', picks: [] },
        { label: 'Newcomer', picks: ['663A'] },
      ],
      availableTeams: ['10G', '12M', '12S', '81Y', '88S', '474G', '663D', '1010N'],
      picksPerSeat: 4,
      notes: [['Picks per team', '4']],
    });
    const byRange = Object.fromEntries(plan.writes.map((w) => [w.range, w.values]));
    expect(byRange['C4:F4']).toEqual([['4873G', '2145V', '', '']]);
    expect(byRange['C6:F6']).toEqual([['12A', '', '', '']]); // whitespace-insensitive match
    expect(byRange['C7:F7']).toEqual([['', '', '', '']]);
    expect(byRange['B8:B8']).toEqual([['Newcomer']]); // appended below the block
    expect(byRange['C8:F8']).toEqual([['663A', '', '', '']]);
    expect(plan.unmatched).toEqual(['Newcomer']);
    expect(plan.clears).toEqual(['B11:H12']);
    expect(byRange['B11:H12']).toEqual([
      ['10G', '12M', '12S', '81Y', '88S', '474G', '663D'],
      ['1010N', '', '', '', '', '', ''],
    ]);
    expect(byRange['B10:B10']).toEqual([['Available Teams (8)']]);
    expect(byRange['G10:G10']).toEqual([['4']]);
  });
});
