export interface Clock {
  /** Current instant as an ISO-8601 UTC string. */
  nowIso(): string;
  /** Current instant in epoch milliseconds. */
  nowMs(): number;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/** Test clock that can be advanced manually. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(start: string | number = '2026-01-01T12:00:00.000Z') {
    this.ms = typeof start === 'number' ? start : Date.parse(start);
  }
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}
