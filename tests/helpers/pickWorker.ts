/**
 * Child process used by the multi-process concurrency test. It opens the shared
 * database file, waits for the "go" file, then attempts a single pick.
 */
import fs from 'node:fs';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { DraftEngine } from '../../src/engine/draftEngine.js';
import { systemClock } from '../../src/util/clock.js';
import { secureRandom } from '../../src/util/random.js';

const [dbPath, draftIdRaw, participantIdRaw, teamIdRaw, goFile] = process.argv.slice(2) as [string, string, string, string, string];
const draftId = Number(draftIdRaw);
const participantId = Number(participantIdRaw);
const teamId = Number(teamIdRaw);

const db = openDatabase(dbPath, { migrate: false });
const engine = new DraftEngine({ repos: createRepositories(db), clock: systemClock, random: secureRandom });
process.send?.({ ready: true });
const spin = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(goFile)) Atomics.wait(spin, 0, 0, 2);
try {
  engine.pick(draftId, { participantId, teamId, actor: { id: 'admin-worker', kind: 'admin' } });
  process.send?.({ ok: true });
} catch (err) {
  process.send?.({ ok: false, message: err instanceof Error ? err.message : String(err) });
} finally {
  db.close();
}
