import { describe, expect, it } from 'vitest';
import { commands } from '../../src/discord/commands/index.js';

/** Sums every name/description/choice string, which is what Discord's 8000-char limit counts. */
function totalChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((n: number, v: unknown) => n + totalChars(v), 0);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).reduce((n: number, v: unknown) => n + totalChars(v), 0);
  return 0;
}

interface OptionLike {
  name: string;
  description: string;
  type: number;
  options?: OptionLike[];
  choices?: Array<{ name: string; value: string | number }>;
}

function walk(options: OptionLike[] | undefined, visit: (o: OptionLike, depth: number) => void, depth = 0): void {
  for (const o of options ?? []) {
    visit(o, depth);
    walk(o.options, visit, depth + 1);
  }
}

describe('slash command definitions', () => {
  it('stay within Discord limits', () => {
    const names = commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of commands) {
      expect(c.data.name).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(c.data.description.length).toBeLessThanOrEqual(100);
      expect(totalChars(c.data)).toBeLessThanOrEqual(8000);
      expect((c.data.options ?? []).length).toBeLessThanOrEqual(25);
      walk(c.data.options as OptionLike[] | undefined, (o, depth) => {
        expect(o.name, `${c.data.name} option ${o.name}`).toMatch(/^[a-z0-9-]{1,32}$/);
        expect(o.description.length, `${c.data.name} option ${o.name} description`).toBeLessThanOrEqual(100);
        expect((o.options ?? []).length).toBeLessThanOrEqual(25);
        expect((o.choices ?? []).length).toBeLessThanOrEqual(25);
        expect(depth).toBeLessThanOrEqual(2);
        // Subcommand names must be unique inside a group.
        if (o.options) {
          const subNames = o.options.map((s) => s.name);
          expect(new Set(subNames).size).toBe(subNames.length);
        }
      });
    }
  });

  it('exposes the expected command surface', () => {
    expect(commands.map((c) => c.data.name).sort()).toEqual(['draft', 'pick', 'prepicks', 'repick', 'roster', 'status', 'team', 'trade']);
    const draft = commands.find((c) => c.data.name === 'draft')!;
    const top = (draft.data.options ?? []).map((o) => o.name).sort();
    expect(top).toEqual(['audit', 'channel', 'complete', 'config', 'import', 'participant', 'pick', 'randomize', 'repick', 'reset', 'roster', 'setup', 'sheet', 'skip', 'start', 'team', 'trade']);
    // admin command hidden by default from members without Manage Server
    expect(draft.data.default_member_permissions).toBe(String(1 << 5));
  });
});
