import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { ADMIN, createTestEnv, setupDraft, user } from '../helpers/env.js';
import { createServiceEnv } from '../helpers/serviceEnv.js';

describe('concurrent picks', () => {
  it('in-process: two simultaneous picks of the same team through the service yield exactly one pick', async () => {
    const env = createServiceEnv();
    const draft = env.engine.createDraft({ guildId: 'g', name: 'C', actor: ADMIN });
    env.engine.updateConfig(draft.id, { rounds: 1, maxInstancesPerTeam: 1 }, ADMIN);
    env.engine.setChannel(draft.id, { channelId: 'c', kind: 'text', parentChannelId: null }, ADMIN);
    const a = env.engine.addParticipant(draft.id, { label: 'A', discordUserIds: ['ua'], actor: ADMIN });
    const b = env.engine.addParticipant(draft.id, { label: 'B', discordUserIds: ['ub'], actor: ADMIN });
    const team = env.engine.addTeam(draft.id, { teamNumber: '1A', teamName: null, organization: null, location: null }, ADMIN);
    env.engine.addTeam(draft.id, { teamNumber: '2A', teamName: null, organization: null, location: null }, ADMIN);
    env.engine.randomize(draft.id, ADMIN);
    await env.service.start(draft.id, ADMIN);
    const turn = env.engine.currentTurn(draft.id)!;
    const other = turn.owner.id === a.id ? b : a;
    const results = await Promise.allSettled([
      env.service.pick(draft.id, { participantId: turn.owner.id, teamId: team.id, actor: user(turn.owner.users[0]!.discordUserId) }),
      env.service.pick(draft.id, { participantId: other.id, teamId: team.id, actor: user(other.users[0]!.discordUserId) }),
      env.service.pick(draft.id, { participantId: turn.owner.id, teamId: team.id, actor: user(turn.owner.users[0]!.discordUserId) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(env.repos.assets.listActiveForTeam(team.id)).toHaveLength(1);
    expect(env.repos.picks.listByDraft(draft.id)).toHaveLength(1);
  });

  it('multi-process: separate processes racing on one database file produce a single pick', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vex-draft-race-'));
    const dbPath = path.join(dir, 'race.db');
    const goFile = path.join(dir, 'go');
    const env = createTestEnv(dbPath);
    const { draftId, order, teams } = setupDraft(env, { participants: 2, teams: 5, config: { rounds: 1, maxInstancesPerTeam: 1 }, start: true });
    const current = order[0]!;
    const team = teams[0]!;
    env.db.close();

    const workerCount = 6;
    const workerPath = fileURLToPath(new URL('../helpers/pickWorker.ts', import.meta.url));
    const children = Array.from({ length: workerCount }, () =>
      fork(workerPath, [dbPath, String(draftId), String(current.id), String(team.id), goFile], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }),
    );
    const ready = Promise.all(children.map((c) => new Promise<void>((resolve) => c.on('message', (m: { ready?: boolean }) => m.ready && resolve()))));
    const results = Promise.all(
      children.map(
        (c) =>
          new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
            let stderr = '';
            c.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
            c.on('message', (m: { ok?: boolean; message?: string }) => m.ok !== undefined && resolve({ ok: m.ok, message: m.message }));
            c.on('exit', (code) => code !== 0 && reject(new Error(`worker exited with ${code}: ${stderr}`)));
          }),
      ),
    );
    await ready;
    fs.writeFileSync(goFile, 'go');
    const outcomes = await results;
    const successes = outcomes.filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    for (const failure of outcomes.filter((r) => !r.ok)) {
      expect(failure.message).toMatch(/no longer available|can't pick right now/);
    }
    const check = createTestEnv(dbPath);
    expect(check.repos.picks.listByDraft(draftId)).toHaveLength(1);
    expect(check.repos.assets.listActiveForTeam(team.id)).toHaveLength(1);
    expect(check.repos.slots.getByOverall(draftId, 1)?.status).toBe('picked');
    check.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('a prepick firing at the same time as a manual pick is serialized', async () => {
    const env = createServiceEnv();
    const draft = env.engine.createDraft({ guildId: 'g', name: 'C', actor: ADMIN });
    env.engine.updateConfig(draft.id, { rounds: 1 }, ADMIN);
    env.engine.setChannel(draft.id, { channelId: 'c', kind: 'text', parentChannelId: null }, ADMIN);
    env.engine.addParticipant(draft.id, { label: 'A', discordUserIds: ['ua'], actor: ADMIN });
    env.engine.addParticipant(draft.id, { label: 'B', discordUserIds: ['ub'], actor: ADMIN });
    const t1 = env.engine.addTeam(draft.id, { teamNumber: '1A', teamName: null, organization: null, location: null }, ADMIN);
    const t2 = env.engine.addTeam(draft.id, { teamNumber: '2A', teamName: null, organization: null, location: null }, ADMIN);
    const order = env.engine.randomize(draft.id, ADMIN);
    const second = order[1]!;
    // Second player prepicks the same team the first player wants.
    env.service.prepicks.add(draft.id, second.id, t1.id, ADMIN);
    await env.service.start(draft.id, ADMIN);
    const first = order[0]!;
    await env.service.pick(draft.id, { participantId: first.id, teamId: t1.id, actor: ADMIN });
    // Prepick fell back: second player did not get 1A; their list dropped it and had nothing else, so they're on the clock.
    expect(env.repos.assets.listActiveForTeam(t1.id)[0]?.currentParticipantId).toBe(first.id);
    expect(env.engine.currentTurn(draft.id)?.owner.id).toBe(second.id);
    expect(env.service.prepicks.list(draft.id, second.id)).toEqual([]);
    expect(env.repos.assets.listActiveForTeam(t2.id)).toHaveLength(0);
  });
});
