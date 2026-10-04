import { DateTime } from 'luxon';
import { parseHHMM } from './config.js';

export interface ActiveWindow {
  /** "HH:MM" local start (inclusive). */
  start: string;
  /** "HH:MM" local end (exclusive). Windows may cross midnight (e.g. 20:00–02:00). */
  end: string;
  timezone: string;
}

function localMinutes(dt: DateTime): number {
  return dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60000;
}

/** Whether the window is active at the given instant. */
export function isWithinWindow(instant: DateTime, window: ActiveWindow): boolean {
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  if (start === end) return true; // 24h
  const local = instant.setZone(window.timezone);
  const m = localMinutes(local);
  if (start < end) return m >= start && m < end;
  return m >= start || m < end; // crosses midnight
}

/** Instant at which the current active period ends (assumes `instant` is within the window). */
export function currentWindowEnd(instant: DateTime, window: ActiveWindow): DateTime {
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  const local = instant.setZone(window.timezone);
  const m = localMinutes(local);
  let endDt = local.startOf('day').plus({ minutes: end });
  if (start >= end && m >= start) {
    // crosses midnight and we are in the pre-midnight part
    endDt = endDt.plus({ days: 1 });
  }
  if (endDt <= local) endDt = endDt.plus({ days: 1 });
  return endDt;
}

/** Next instant at which the window becomes active (assumes `instant` is outside it). */
export function nextWindowStart(instant: DateTime, window: ActiveWindow): DateTime {
  const start = parseHHMM(window.start);
  const local = instant.setZone(window.timezone);
  let startDt = local.startOf('day').plus({ minutes: start });
  if (startDt <= local) startDt = startDt.plus({ days: 1 });
  return startDt;
}

/**
 * Computes when a timer of `durationSeconds` expires if it only counts down while the
 * window is active. Returns an ISO instant.
 */
export function computeDeadline(startIso: string, durationSeconds: number, window: ActiveWindow | null): string {
  let t: DateTime = DateTime.fromISO(startIso, { zone: 'utc' });
  if (!t.isValid) throw new Error(`Invalid start instant: ${startIso}`);
  if (!window || durationSeconds <= 0) {
    return t.plus({ seconds: durationSeconds }).toUTC().toISO() as string;
  }
  let remaining = durationSeconds;
  let guard = 0;
  while (remaining > 0) {
    guard += 1;
    if (guard > 10000) throw new Error('computeDeadline did not converge');
    if (!isWithinWindow(t, window)) {
      t = nextWindowStart(t, window);
      continue;
    }
    const end = currentWindowEnd(t, window);
    const available = end.diff(t, 'seconds').seconds;
    if (available >= remaining) {
      t = t.plus({ seconds: remaining });
      remaining = 0;
    } else {
      remaining -= available;
      t = end;
    }
  }
  return t.toUTC().toISO() as string;
}

/**
 * Seconds of active time remaining before `deadlineIso`, as seen from `nowIso`.
 * Also reports whether the timer is currently paused (outside the active window).
 */
export function remainingActiveSeconds(
  nowIso: string,
  deadlineIso: string,
  window: ActiveWindow | null,
): { seconds: number; paused: boolean; resumesAt: string | null } {
  let t: DateTime = DateTime.fromISO(nowIso, { zone: 'utc' });
  const deadline: DateTime = DateTime.fromISO(deadlineIso, { zone: 'utc' });
  if (deadline <= t) return { seconds: 0, paused: false, resumesAt: null };
  if (!window) return { seconds: Math.ceil(deadline.diff(t, 'seconds').seconds), paused: false, resumesAt: null };
  const paused = !isWithinWindow(t, window);
  const resumesAt = paused ? nextWindowStart(t, window).toUTC().toISO() : null;
  let seconds = 0;
  let guard = 0;
  while (t < deadline) {
    guard += 1;
    if (guard > 10000) break;
    if (!isWithinWindow(t, window)) {
      t = nextWindowStart(t, window);
      continue;
    }
    const end = currentWindowEnd(t, window);
    const stop = end < deadline ? end : deadline;
    seconds += stop.diff(t, 'seconds').seconds;
    t = stop;
  }
  return { seconds: Math.ceil(seconds), paused, resumesAt };
}
