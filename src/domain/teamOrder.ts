/**
 * Natural ordering for VEX team numbers: numeric part first (10G < 12A < 81Y < 474G),
 * then the letter suffix, so lists read like a scoreboard instead of a string sort.
 */
export function teamSortKey(teamNumber: string): [number, string] {
  const m = /^(\d+)(.*)$/.exec(teamNumber);
  return m ? [Number(m[1]), m[2] as string] : [Number.MAX_SAFE_INTEGER, teamNumber];
}

export function compareTeamNumbers(a: string, b: string): number {
  const [na, sa] = teamSortKey(a);
  const [nb, sb] = teamSortKey(b);
  if (na !== nb) return na - nb;
  return sa.localeCompare(sb);
}

export function sortTeams<T extends { teamNumber: string }>(teams: T[]): T[] {
  return [...teams].sort((x, y) => compareTeamNumbers(x.teamNumber, y.teamNumber));
}
