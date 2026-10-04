import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations.js';

export type SqliteDatabase = Database.Database;

export interface OpenOptions {
  /** Apply pending migrations immediately (default true). */
  migrate?: boolean;
}

/**
 * Opens (and creates if needed) the SQLite database with production pragmas:
 * WAL journaling for concurrent readers, foreign keys enforced, and a busy timeout so
 * a second process/connection waits instead of failing when the writer holds the lock.
 */
export function openDatabase(filePath: string, opts: OpenOptions = {}): SqliteDatabase {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  if (opts.migrate !== false) {
    runMigrations(db);
  }
  return db;
}

/**
 * Runs `fn` inside a BEGIN IMMEDIATE transaction. IMMEDIATE acquires the write lock up
 * front, so validation reads inside the transaction see a state no other writer can
 * change before we commit. Nested calls reuse the outer transaction.
 */
export function inTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}
