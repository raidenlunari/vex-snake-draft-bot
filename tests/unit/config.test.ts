import { describe, expect, it } from 'vitest';
import { assertConfigChangeAllowed, defaultDraftConfig, formatDuration, parseDuration, parseHHMM, validateConfig } from '../../src/domain/config.js';

describe('config helpers', () => {
  it('parses durations', () => {
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('20')).toBe(1200);
    expect(parseDuration('2 hours')).toBe(7200);
    expect(() => parseDuration('soon')).toThrow();
    expect(formatDuration(5400)).toBe('1h 30m');
  });

  it('parses HH:MM', () => {
    expect(parseHHMM('09:30')).toBe(570);
    expect(() => parseHHMM('25:00')).toThrow();
    expect(() => parseHHMM('9am')).toThrow();
  });

  it('validates configs', () => {
    const base = defaultDraftConfig('UTC');
    expect(validateConfig(base)).toEqual([]);
    expect(validateConfig({ ...base, rounds: 0 })).toContain('Rounds must be between 1 and 100.');
    expect(validateConfig({ ...base, timezone: 'Mars/Olympus' })[0]).toMatch(/time zone/);
    expect(validateConfig({ ...base, skipHoursStart: '09:00', skipHoursEnd: null })).toContain('Skip hours need both a start and an end time.');
    expect(validateConfig({ ...base, allowTrades: false, allowTwoForOne: true })).toContain('2-for-1 trades require trades to be enabled.');
  });

  it('locks structural settings while active', () => {
    expect(() => assertConfigChangeAllowed('active', ['rounds'])).toThrow(/locked/);
    expect(() => assertConfigChangeAllowed('active', ['skipTimerSeconds'])).not.toThrow();
    expect(() => assertConfigChangeAllowed('setup', ['rounds'])).not.toThrow();
    expect(() => assertConfigChangeAllowed('archived', ['allowTrades'])).toThrow();
  });
});
