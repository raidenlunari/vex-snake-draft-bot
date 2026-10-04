import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/services/lock.js';

describe('KeyedMutex', () => {
  it('serializes work per key and runs different keys concurrently', async () => {
    const lock = new KeyedMutex();
    const log: string[] = [];
    const task = (key: string, name: string, ms: number) =>
      lock.run(key, async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
      });
    await Promise.all([task('a', 'a1', 20), task('a', 'a2', 5), task('b', 'b1', 1)]);
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'));
    expect(log.indexOf('b1:end')).toBeLessThan(log.indexOf('a1:end'));
    expect(lock.isLocked('a')).toBe(false);
  });

  it('releases the lock when the task throws', async () => {
    const lock = new KeyedMutex();
    await expect(lock.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const value = await lock.run('k', () => 42);
    expect(value).toBe(42);
  });
});
