import type { SqliteDatabase } from '../connection.js';
import type { Participant, ParticipantUser, ParticipantWithUsers } from '../../domain/types.js';
import { mapParticipant, mapParticipantUser, type Row } from './mappers.js';

export class ParticipantRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: { draftId: number; label: string; createdBy: string; now: string }): Participant {
    const res = this.db
      .prepare('INSERT INTO participants (draft_id, label, created_at, created_by) VALUES (?, ?, ?, ?)')
      .run(input.draftId, input.label, input.now, input.createdBy);
    return this.getById(Number(res.lastInsertRowid)) as Participant;
  }

  getById(id: number): Participant | null {
    const row = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as Row | undefined;
    return row ? mapParticipant(row) : null;
  }

  getByLabel(draftId: number, label: string): Participant | null {
    const row = this.db
      .prepare('SELECT * FROM participants WHERE draft_id = ? AND label = ? COLLATE NOCASE')
      .get(draftId, label) as Row | undefined;
    return row ? mapParticipant(row) : null;
  }

  listByDraft(draftId: number): Participant[] {
    return (
      this.db
        .prepare('SELECT * FROM participants WHERE draft_id = ? ORDER BY draft_position IS NULL, draft_position, id')
        .all(draftId) as Row[]
    ).map(mapParticipant);
  }

  listWithUsers(draftId: number): ParticipantWithUsers[] {
    const participants = this.listByDraft(draftId);
    const users = (this.db.prepare('SELECT * FROM participant_users WHERE draft_id = ? ORDER BY added_at, discord_user_id').all(draftId) as Row[]).map(mapParticipantUser);
    return participants.map((p) => ({ ...p, users: users.filter((u) => u.participantId === p.id) }));
  }

  getWithUsers(participantId: number): ParticipantWithUsers | null {
    const p = this.getById(participantId);
    if (!p) return null;
    return { ...p, users: this.listUsers(participantId) };
  }

  listUsers(participantId: number): ParticipantUser[] {
    return (this.db.prepare('SELECT * FROM participant_users WHERE participant_id = ? ORDER BY added_at').all(participantId) as Row[]).map(mapParticipantUser);
  }

  listSeatsForUser(draftId: number, discordUserId: string): Participant[] {
    return (
      this.db
        .prepare(
          `SELECT p.* FROM participants p
           JOIN participant_users pu ON pu.participant_id = p.id
           WHERE p.draft_id = ? AND pu.discord_user_id = ?
           ORDER BY p.draft_position IS NULL, p.draft_position, p.id`,
        )
        .all(draftId, discordUserId) as Row[]
    ).map(mapParticipant);
  }

  isMember(participantId: number, discordUserId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM participant_users WHERE participant_id = ? AND discord_user_id = ?').get(participantId, discordUserId);
    return row !== undefined;
  }

  addUser(input: { draftId: number; participantId: number; discordUserId: string; role: 'owner' | 'manager'; now: string }): void {
    this.db
      .prepare('INSERT INTO participant_users (participant_id, draft_id, discord_user_id, role, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.participantId, input.draftId, input.discordUserId, input.role, input.now);
  }

  removeUser(participantId: number, discordUserId: string): void {
    this.db.prepare('DELETE FROM participant_users WHERE participant_id = ? AND discord_user_id = ?').run(participantId, discordUserId);
  }

  delete(participantId: number): void {
    this.db.prepare('DELETE FROM participants WHERE id = ?').run(participantId);
  }

  setPosition(participantId: number, position: number | null): void {
    this.db.prepare('UPDATE participants SET draft_position = ? WHERE id = ?').run(position, participantId);
  }

  clearPositions(draftId: number): void {
    this.db.prepare('UPDATE participants SET draft_position = NULL WHERE draft_id = ?').run(draftId);
  }

  setLabel(participantId: number, label: string): void {
    this.db.prepare('UPDATE participants SET label = ? WHERE id = ?').run(label, participantId);
  }
}
