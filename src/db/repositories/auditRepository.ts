import type { SqliteDatabase } from '../connection.js';
import type { Actor, AuditEvent } from '../../domain/types.js';
import { mapAudit, type Row } from './mappers.js';

export interface AuditInput {
  guildId: string | null;
  draftId: number | null;
  eventType: string;
  actor: Actor;
  summary: string;
  subject?: unknown;
  before?: unknown;
  after?: unknown;
  now: string;
}

export class AuditRepository {
  constructor(private readonly db: SqliteDatabase) {}

  record(input: AuditInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO audit_events (guild_id, draft_id, event_type, actor_id, actor_kind, summary, subject_json, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.guildId,
        input.draftId,
        input.eventType,
        input.actor.id,
        input.actor.kind,
        input.summary,
        input.subject === undefined ? null : JSON.stringify(input.subject),
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        input.now,
      );
    return Number(res.lastInsertRowid);
  }

  listForDraft(draftId: number, limit = 50, offset = 0): AuditEvent[] {
    return (this.db.prepare('SELECT * FROM audit_events WHERE draft_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(draftId, limit, offset) as Row[]).map(mapAudit);
  }

  listForGuild(guildId: string, limit = 50): AuditEvent[] {
    return (this.db.prepare('SELECT * FROM audit_events WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guildId, limit) as Row[]).map(mapAudit);
  }

  listByType(draftId: number, eventType: string): AuditEvent[] {
    return (this.db.prepare('SELECT * FROM audit_events WHERE draft_id = ? AND event_type = ? ORDER BY id').all(draftId, eventType) as Row[]).map(mapAudit);
  }

  countForDraft(draftId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE draft_id = ?').get(draftId) as { c: number }).c;
  }
}
