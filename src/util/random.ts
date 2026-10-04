import { randomInt, randomUUID } from 'node:crypto';

export interface RandomSource {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  uuid(): string;
}

export const secureRandom: RandomSource = {
  int: (max) => randomInt(max),
  uuid: () => randomUUID(),
};

/** Fisher–Yates shuffle using the provided random source. Returns a new array. */
export function shuffle<T>(items: readonly T[], random: RandomSource = secureRandom): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/** Deterministic random source for tests (seeded LCG). */
export class SeededRandom implements RandomSource {
  private state: number;
  private counter = 0;
  constructor(seed = 42) {
    this.state = seed >>> 0;
  }
  int(maxExclusive: number): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state % maxExclusive;
  }
  uuid(): string {
    this.counter += 1;
    return `test-uuid-${this.counter}`;
  }
}
