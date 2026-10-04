import { describe, expect, it } from 'vitest';
import { generatePickOrder, roundSeatOrder, totalPicks } from '../../src/domain/snakeOrder.js';

describe('snake order generation', () => {
  it('produces the documented order for 4 participants and 3 rounds', () => {
    const slots = generatePickOrder({ participantCount: 4, rounds: 3, picksPerRound: 1, snake: true });
    const seats = slots.map((s) => s.seatIndex);
    expect(seats).toEqual([0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]);
    expect(slots.map((s) => s.overall)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(slots.map((s) => s.round)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(slots.map((s) => s.pickInRound)).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('runs every round forward when snake is disabled', () => {
    const slots = generatePickOrder({ participantCount: 3, rounds: 2, picksPerRound: 1, snake: false });
    expect(slots.map((s) => s.seatIndex)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('supports multiple picks per participant per round', () => {
    const slots = generatePickOrder({ participantCount: 2, rounds: 2, picksPerRound: 2, snake: true });
    expect(slots.map((s) => s.seatIndex)).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
    expect(slots.map((s) => s.pickInTurn)).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
    expect(slots.map((s) => s.turnInRound)).toEqual([1, 1, 2, 2, 1, 1, 2, 2]);
    expect(totalPicks({ participantCount: 2, rounds: 2, picksPerRound: 2, snake: true })).toBe(8);
  });

  it('handles many rounds and participants with unique overall numbers', () => {
    const slots = generatePickOrder({ participantCount: 12, rounds: 8, picksPerRound: 1, snake: true });
    expect(slots).toHaveLength(96);
    expect(new Set(slots.map((s) => s.overall)).size).toBe(96);
    for (let r = 1; r <= 8; r++) {
      const round = slots.filter((s) => s.round === r);
      expect(new Set(round.map((s) => s.seatIndex)).size).toBe(12);
    }
    expect(roundSeatOrder(2, 3, true)).toEqual([2, 1, 0]);
    expect(roundSeatOrder(3, 3, true)).toEqual([0, 1, 2]);
  });

  it('rejects invalid inputs', () => {
    expect(() => generatePickOrder({ participantCount: 0, rounds: 1, picksPerRound: 1, snake: true })).toThrow();
    expect(() => generatePickOrder({ participantCount: 2, rounds: 0, picksPerRound: 1, snake: true })).toThrow();
    expect(() => generatePickOrder({ participantCount: 2, rounds: 1, picksPerRound: 0, snake: true })).toThrow();
  });
});
