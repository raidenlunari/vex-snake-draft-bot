import { DateTime } from 'luxon';
import { DraftError } from './errors.js';
import type { DraftConfig, DraftStatus } from './types.js';

export function defaultDraftConfig(timezone = 'UTC'): DraftConfig {
  return {
    participantCount: null,
    rounds: 8,
    picksPerRound: 1,
    snakeOrder: true,
    skipTimerSeconds: null,
    skipHoursStart: null,
    skipHoursEnd: null,
    timezone,
    allowPrepicks: true,
    prepickMode: 'immediate',
    allowTrades: true,
    allowTwoForOne: false,
    allowFuturePickTrades: false,
    tradeApproval: 'counterparty',
    allowTradesAfterCompletion: false,
    afterSkipPolicy: 'catch_up',
    maxInstancesPerTeam: 1,
    maxSeatsPerUser: 1,
    maxRosterSize: null,
    requirePickConfirmation: false,
    allowSwaps: true,
  };
}

/**
 * Fields that cannot change once the draft is active because pick slots have been
 * materialized from them.
 */
export const LOCKED_WHEN_ACTIVE: ReadonlyArray<keyof DraftConfig> = [
  'participantCount',
  'rounds',
  'picksPerRound',
  'snakeOrder',
  'maxSeatsPerUser',
];

export const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

export function parseHHMM(value: string): number {
  const m = HHMM_RE.exec(value.trim());
  if (!m) throw new DraftError('VALIDATION', `"${value}" is not a valid time. Use 24-hour HH:MM, for example 09:00 or 21:30.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Parses "15m", "1h30m", "90", "2h", "45s" into seconds. */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text) * 60; // bare number = minutes
  const re = /(\d+)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)/g;
  let total = 0;
  let matched = false;
  let consumed = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    consumed += m[0];
    const n = Number(m[1]);
    const unit = m[2] ?? 'm';
    if (unit.startsWith('h')) total += n * 3600;
    else if (unit.startsWith('m')) total += n * 60;
    else total += n;
  }
  if (!matched || consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) {
    throw new DraftError('VALIDATION', `"${input}" is not a valid duration. Examples: 15m, 1h30m, 90s, or 0 to disable.`);
  }
  return total;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ');
}

export function validateConfig(config: DraftConfig): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds > 100) {
    problems.push('Rounds must be between 1 and 100.');
  }
  if (!Number.isInteger(config.picksPerRound) || config.picksPerRound < 1 || config.picksPerRound > 10) {
    problems.push('Picks per round must be between 1 and 10.');
  }
  if (config.participantCount !== null && (!Number.isInteger(config.participantCount) || config.participantCount < 1)) {
    problems.push('Participant count must be a positive number.');
  }
  if (config.skipTimerSeconds !== null && (config.skipTimerSeconds < 0 || config.skipTimerSeconds > 7 * 86400)) {
    problems.push('Skip timer must be between 0 and 7 days.');
  }
  if ((config.skipHoursStart === null) !== (config.skipHoursEnd === null)) {
    problems.push('Skip hours need both a start and an end time.');
  }
  if (config.skipHoursStart !== null && !HHMM_RE.test(config.skipHoursStart)) {
    problems.push('Skip hours start must be HH:MM.');
  }
  if (config.skipHoursEnd !== null && !HHMM_RE.test(config.skipHoursEnd)) {
    problems.push('Skip hours end must be HH:MM.');
  }
  if (!isValidTimezone(config.timezone)) {
    problems.push(`Time zone "${config.timezone}" is not a valid IANA time zone (example: America/New_York).`);
  }
  if (!Number.isInteger(config.maxInstancesPerTeam) || config.maxInstancesPerTeam < 1 || config.maxInstancesPerTeam > 50) {
    problems.push('Max instances per team must be between 1 and 50.');
  }
  if (!Number.isInteger(config.maxSeatsPerUser) || config.maxSeatsPerUser < 1 || config.maxSeatsPerUser > 50) {
    problems.push('Max seats per user must be between 1 and 50.');
  }
  if (config.maxRosterSize !== null && (!Number.isInteger(config.maxRosterSize) || config.maxRosterSize < 1)) {
    problems.push('Max roster size must be a positive number or unlimited.');
  }
  if (config.allowTwoForOne && !config.allowTrades) {
    problems.push('2-for-1 trades require trades to be enabled.');
  }
  if (config.allowFuturePickTrades && !config.allowTrades) {
    problems.push('Future-pick trades require trades to be enabled.');
  }
  return problems;
}

export function assertConfigChangeAllowed(status: DraftStatus, keys: Array<keyof DraftConfig>): void {
  if (status === 'active' || status === 'completed') {
    const locked = keys.filter((k) => LOCKED_WHEN_ACTIVE.includes(k));
    if (locked.length > 0) {
      throw new DraftError(
        'CONFIG_LOCKED',
        `These settings are locked while the draft is ${status}: ${locked.join(', ')}. Reset the draft to change them.`,
      );
    }
  }
  if (status === 'archived') {
    throw new DraftError('INVALID_STATE', 'This draft has been reset. Run /draft setup to create a new one.');
  }
}

export function describeConfig(config: DraftConfig): Array<[string, string]> {
  const onOff = (b: boolean): string => (b ? 'on' : 'off');
  const skipHours =
    config.skipHoursStart && config.skipHoursEnd
      ? `${config.skipHoursStart}–${config.skipHoursEnd} (${config.timezone})`
      : `always (${config.timezone})`;
  return [
    ['Participants', config.participantCount === null ? 'as registered' : String(config.participantCount)],
    ['Rounds', String(config.rounds)],
    ['Picks per round', String(config.picksPerRound)],
    ['Snake order', onOff(config.snakeOrder)],
    ['Skip timer', config.skipTimerSeconds ? formatDuration(config.skipTimerSeconds) : 'off'],
    ['Skip timer hours', skipHours],
    ['After skip', config.afterSkipPolicy === 'catch_up' ? 'skipped player may pick later' : 'pick is forfeited'],
    ['Prepicks', config.allowPrepicks ? `on (${config.prepickMode === 'immediate' ? 'applied immediately' : 'applied on timeout'})` : 'off'],
    ['Pick confirmation', onOff(config.requirePickConfirmation)],
    ['Swaps (/swap)', onOff(config.allowSwaps)],
    ['Trades', onOff(config.allowTrades)],
    ['2-for-1 trades', onOff(config.allowTwoForOne)],
    ['Future-pick trades', onOff(config.allowFuturePickTrades)],
    ['Trade approval', config.tradeApproval],
    ['Trades after completion', onOff(config.allowTradesAfterCompletion)],
    ['Copies of each team', String(config.maxInstancesPerTeam)],
    ['Seats per user', String(config.maxSeatsPerUser)],
    ['Max roster size', config.maxRosterSize === null ? 'unlimited' : String(config.maxRosterSize)],
  ];
}
