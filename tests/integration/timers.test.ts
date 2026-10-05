import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock } from '../../src/util/clock.js';
import { ADMIN, user } from '../helpers/env.js';
import { createServiceEnv, type ServiceEnv } from '../helpers/serviceEnv.js';

function makeDraft(env: ServiceEnv, config: Record<string, unknown> = {}) {
  const draft = env.engine.createDraft({ guildId: 'g', name: 'Timed', actor: ADMIN });
  env.engine.updateConfig(draft.id, { rounds: 2, skipTimerSeconds: 600, ...config }, ADMIN);
  env.engine.setChannel(draft.id, { channelId: 'c', kind: 'text', parentChannelId: null }, ADMIN);
  for (let i = 1; i <= 3; i++) env.engine.addParticipant(draft.id, { label: `P${i}`, discordUserIds: [`u${i}`], actor: ADMIN });
  for (let i = 1; i <= 10; i++) env.engine.addTeam(draft.id, { teamNumber: `${i}A`, teamName: null, organization: null, location: null }, ADMIN);
  env.engine.randomize(draft.id, ADMIN);
  return draft.id;
}

describe('turn timers', () => {
  it('arms on start, auto-skips on expiry, and re-arms for the next player', async () => {
    const env = createServiceEnv();
    const draftId = makeDraft(env);
    await env.service.start(draftId, ADMIN);
    expect(env.timers.armedCount()).toBe(1);
    const first = env.repos.drafts.getById(draftId)!;
    expect(first.turnDeadlineAt).toBe(new Date(env.clock.nowMs() + 600_000).toISOString());
    // Announcement mentions the timer.
    expect(env.announcer.sent.some((s) => s.payload.content?.includes('Auto-skip'))).toBe(true);

    await env.scheduler.advance(599_000);
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('current');
    await env.scheduler.advance(2_000);
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('skipped');
    const second = env.repos.drafts.getById(draftId)!;
    expect(second.currentSlotId).not.toBe(first.currentSlotId);
    expect(second.turnToken).not.toBe(first.turnToken);
    expect(env.timers.armedCount()).toBe(1);
    expect(env.announcer.sent.some((s) => s.payload.content?.includes('skipped'))).toBe(true);
  });

  it('a pick resets the timer so the old deadline never fires', async () => {
    const env = createServiceEnv();
    const draftId = makeDraft(env);
    await env.service.start(draftId, ADMIN);
    await env.scheduler.advance(500_000);
    const turn = env.engine.currentTurn(draftId)!;
    const team = env.repos.teams.listAvailable(draftId, 1)[0]!;
    await env.service.pick(draftId, { participantId: turn.owner.id, teamId: team.id, actor: user(turn.owner.users[0]!.discordUserId) });
    await env.scheduler.advance(200_000); // old deadline passes
    expect(env.repos.slots.countByStatus(draftId).skipped).toBe(0);
    await env.scheduler.advance(500_000); // new deadline passes
    expect(env.repos.slots.countByStatus(draftId).skipped).toBe(1);
  });

  it('a timer firing concurrently with a pick cannot produce two resolutions of one slot', async () => {
    const env = createServiceEnv();
    const draftId = makeDraft(env);
    await env.service.start(draftId, ADMIN);
    const draft = env.repos.drafts.getById(draftId)!;
    env.clock.advance(601_000);
    const turn = env.engine.currentTurn(draftId)!;
    const team = env.repos.teams.listAvailable(draftId, 1)[0]!;
    const results = await Promise.allSettled([
      env.service.handleTimerExpiry(draftId, draft.turnToken!),
      env.service.pick(draftId, { participantId: turn.owner.id, teamId: team.id, actor: ADMIN }),
      env.service.handleTimerExpiry(draftId, draft.turnToken!),
    ]);
    const slot1 = env.repos.slots.getByOverall(draftId, 1)!;
    // Either the timer skipped first (pick then fails or becomes a catch-up) or the pick won (timer no-ops);
    // in no case is slot 1 resolved twice.
    const picks = env.repos.picks.listByDraft(draftId).filter((p) => p.overallPick === 1);
    expect(picks.length).toBeLessThanOrEqual(1);
    expect(['picked', 'skipped']).toContain(slot1.status);
    expect(results.filter((r) => r.status === 'rejected').length).toBeLessThanOrEqual(1);
    const audits = env.repos.audit.listByType(draftId, 'pick_skipped').length + env.repos.audit.listByType(draftId, 'pick_made').length + env.repos.audit.listByType(draftId, 'pick_catch_up').length;
    expect(audits).toBeGreaterThanOrEqual(1);
  });

  it('pauses outside active hours', async () => {
    const env = createServiceEnv(':memory:', new FakeClock('2026-01-10T23:00:00.000Z')); // 18:00 New York
    const draftId = makeDraft(env, { skipTimerSeconds: 7200, skipHoursStart: '09:00', skipHoursEnd: '19:00', timezone: 'America/New_York' });
    await env.service.start(draftId, ADMIN);
    const d = env.repos.drafts.getById(draftId)!;
    // 1h until 19:00, remaining 1h from 09:00 next day -> 10:00 NY = 15:00Z
    expect(d.turnDeadlineAt).toBe('2026-01-11T15:00:00.000Z');
    await env.scheduler.advance(5 * 3600_000); // 04:00Z, still paused
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('current');
    await env.scheduler.advance(12 * 3600_000); // past 15:00Z
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('skipped');
  });

  it('changing the timer mid-turn re-derives the running deadline; disabling disarms it', async () => {
    const env = createServiceEnv();
    const draftId = makeDraft(env);
    await env.service.start(draftId, ADMIN);
    const startedAt = env.repos.drafts.getById(draftId)!.turnStartedAt!;
    await env.service.updateConfig(draftId, { skipTimerSeconds: 1200 }, ADMIN);
    expect(env.repos.drafts.getById(draftId)?.turnDeadlineAt).toBe(new Date(Date.parse(startedAt) + 1_200_000).toISOString());
    await env.scheduler.advance(700_000); // old 10-minute deadline passed, new one has not
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('current');
    await env.service.updateConfig(draftId, { skipTimerSeconds: null }, ADMIN);
    expect(env.repos.drafts.getById(draftId)?.turnDeadlineAt).toBeNull();
    expect(env.timers.armedCount()).toBe(0);
    await env.scheduler.advance(3_600_000);
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('current');
    await env.service.updateConfig(draftId, { skipTimerSeconds: 60 }, ADMIN);
    // Re-enabled: the deadline is derived from the turn start, which is long past, so it fires on the next sweep/timer.
    await env.scheduler.advance(1_000);
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('skipped');
  });
});

describe('restart recovery', () => {
  it('re-arms timers from the database and fires overdue ones immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vex-draft-'));
    const dbPath = path.join(dir, 'draft.db');
    const clock = new FakeClock();
    const first = createServiceEnv(dbPath, clock);
    const draftId = makeDraft(first);
    await first.service.start(draftId, ADMIN);
    const before = first.repos.drafts.getById(draftId)!;
    first.timers.stop();
    first.repos.db.close();

    // "Restart" while the deadline is still in the future.
    const second = createServiceEnv(dbPath, clock);
    expect(second.repos.drafts.getById(draftId)?.status).toBe('active');
    await second.timers.recoverAll();
    expect(second.timers.armedCount()).toBe(1);
    await second.scheduler.advance(601_000);
    expect(second.repos.slots.getByOverall(draftId, 1)?.status).toBe('skipped');
    expect(second.repos.drafts.getById(draftId)?.currentSlotId).not.toBe(before.currentSlotId);
    second.timers.stop();
    second.repos.db.close();

    // "Restart" after the deadline already passed while the bot was down.
    clock.advance(2 * 3600_000);
    const third = createServiceEnv(dbPath, clock);
    await third.timers.recoverAll();
    expect(third.repos.slots.getByOverall(draftId, 2)?.status).toBe('skipped');
    expect(third.repos.slots.getByOverall(draftId, 3)?.status).toBe('current');
    expect(third.timers.armedCount()).toBe(1);
    third.timers.stop();
    third.repos.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the safety sweep catches a lost timeout', async () => {
    const env = createServiceEnv();
    const draftId = makeDraft(env);
    await env.service.start(draftId, ADMIN);
    // Simulate a lost in-memory timeout.
    env.timers.disarm(draftId);
    expect(env.timers.armedCount()).toBe(0);
    env.clock.advance(601_000);
    await env.timers.sweep();
    expect(env.repos.slots.getByOverall(draftId, 1)?.status).toBe('skipped');
  });
});
