import 'dotenv/config';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrations.js';

const dbPath = process.env.DATABASE_PATH ?? './data/draft.db';
const db = openDatabase(dbPath, { migrate: false });
const applied = runMigrations(db);
console.log(`Applied ${applied} migration(s) to ${dbPath}`);
db.close();
