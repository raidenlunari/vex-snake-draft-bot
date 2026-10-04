import { describe, expect, it } from 'vitest';
import { computeDeadline, isWithinWindow, remainingActiveSeconds } from '../../src/domain/activeHours.js';
import { DateTime } from 'luxon';

const NY = { start: '09:00', end: '22:00', timezone: 'America/New_York' };

describe('active hours deadline math', () => {
  it('adds the duration directly when there is no window', () => {
    expect(computeDeadline('2026-03-01T10:00:00.000Z', 600, null)).toBe('2026-03-01T10:10:00.000Z');
  });

  it('counts down only inside the window and pauses overnight', () => {
    // 21:50 New York (EST, UTC-5) = 02:50Z next day
    const start = DateTime.fromISO('2026-01-10T21:50:00', { zone: 'America/New_York' }).toUTC().toISO() as string;
    const deadline = computeDeadline(start, 30 * 60, NY);
    const local = DateTime.fromISO(deadline).setZone('America/New_York');
    expect(local.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-01-11 09:20');
  });

  it('starts counting at the next window start when the turn begins outside the window', () => {
    const start = DateTime.fromISO('2026-01-10T23:30:00', { zone: 'America/New_York' }).toUTC().toISO() as string;
    const deadline = computeDeadline(start, 15 * 60, NY);
    expect(DateTime.fromISO(deadline).setZone('America/New_York').toFormat('HH:mm')).toBe('09:15');
  });

  it('handles windows that cross midnight', () => {
    const window = { start: '20:00', end: '02:00', timezone: 'UTC' };
    expect(isWithinWindow(DateTime.fromISO('2026-01-10T23:00:00Z'), window)).toBe(true);
    expect(isWithinWindow(DateTime.fromISO('2026-01-11T01:00:00Z'), window)).toBe(true);
    expect(isWithinWindow(DateTime.fromISO('2026-01-11T03:00:00Z'), window)).toBe(false);
    expect(computeDeadline('2026-01-11T01:30:00.000Z', 3600, window)).toBe('2026-01-11T20:30:00.000Z');
  });

  it('reports remaining time and paused state', () => {
    const deadline = '2026-01-11T14:20:00.000Z'; // 09:20 NY
    const now = DateTime.fromISO('2026-01-11T03:00:00', { zone: 'America/New_York' }).toUTC().toISO() as string;
    const r = remainingActiveSeconds(now, deadline, NY);
    expect(r.paused).toBe(true);
    expect(r.seconds).toBe(20 * 60);
    expect(r.resumesAt).not.toBeNull();
    const later = remainingActiveSeconds('2026-01-11T14:10:00.000Z', deadline, NY);
    expect(later.paused).toBe(false);
    expect(later.seconds).toBe(600);
    expect(remainingActiveSeconds('2026-01-11T15:00:00.000Z', deadline, NY).seconds).toBe(0);
  });

  it('respects daylight saving transitions', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT. Start 21:30 on 03-07, 1h timer: 30 min to 22:00, 30 min from 09:00 next day.
    const start = DateTime.fromISO('2026-03-07T21:30:00', { zone: 'America/New_York' }).toUTC().toISO() as string;
    const deadline = computeDeadline(start, 3600, NY);
    expect(DateTime.fromISO(deadline).setZone('America/New_York').toFormat('yyyy-MM-dd HH:mm ZZZZ')).toBe('2026-03-08 09:30 EDT');
  });
});
