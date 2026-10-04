/**
 * Pure snake-order generation. No database, no Discord.
 *
 * Seats are addressed by their 0-based index in the randomized draft order.
 * Each round is made of `participantCount` turns; each turn is `picksPerRound`
 * consecutive slots for the same seat. With `snake` enabled, even rounds run
 * in reverse seat order.
 */
export interface PickOrderOptions {
  participantCount: number;
  rounds: number;
  picksPerRound: number;
  snake: boolean;
}

export interface PickSlotSpec {
  /** 1-based overall pick number across the whole draft. */
  overall: number;
  /** 1-based round. */
  round: number;
  /** 1-based pick number within the round. */
  pickInRound: number;
  /** 1-based turn number within the round. */
  turnInRound: number;
  /** 1-based pick number within the turn (1..picksPerRound). */
  pickInTurn: number;
  /** 0-based index of the seat in the randomized order. */
  seatIndex: number;
}

export function roundSeatOrder(roundNumber: number, participantCount: number, snake: boolean): number[] {
  const forward = Array.from({ length: participantCount }, (_, i) => i);
  if (!snake) return forward;
  return roundNumber % 2 === 1 ? forward : forward.reverse();
}

export function generatePickOrder(opts: PickOrderOptions): PickSlotSpec[] {
  const { participantCount, rounds, picksPerRound, snake } = opts;
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    throw new Error('participantCount must be a positive integer');
  }
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error('rounds must be a positive integer');
  }
  if (!Number.isInteger(picksPerRound) || picksPerRound < 1) {
    throw new Error('picksPerRound must be a positive integer');
  }

  const slots: PickSlotSpec[] = [];
  let overall = 0;
  for (let round = 1; round <= rounds; round++) {
    const order = roundSeatOrder(round, participantCount, snake);
    let pickInRound = 0;
    order.forEach((seatIndex, turnIdx) => {
      for (let p = 1; p <= picksPerRound; p++) {
        overall += 1;
        pickInRound += 1;
        slots.push({
          overall,
          round,
          pickInRound,
          turnInRound: turnIdx + 1,
          pickInTurn: p,
          seatIndex,
        });
      }
    });
  }
  return slots;
}

export function totalPicks(opts: PickOrderOptions): number {
  return opts.participantCount * opts.rounds * opts.picksPerRound;
}
