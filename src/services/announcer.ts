import type { Draft } from '../domain/types.js';

/** Discord-agnostic message payload rendered by the announcer implementation. */
export interface EmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface ButtonSpec {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
  emoji?: string;
}

export interface AnnouncementPayload {
  content?: string;
  embeds?: EmbedPayload[];
  buttons?: ButtonSpec[];
  /** Discord user ids allowed to be pinged by this message. */
  mentionUserIds?: string[];
}

export interface AnnouncementRef {
  channelId: string;
  messageId: string;
}

export interface Announcer {
  announce(draft: Draft, payload: AnnouncementPayload): Promise<AnnouncementRef | null>;
  update(ref: AnnouncementRef, payload: AnnouncementPayload): Promise<void>;
}

export class NoopAnnouncer implements Announcer {
  async announce(): Promise<AnnouncementRef | null> {
    return null;
  }
  async update(): Promise<void> {
    /* intentionally empty */
  }
}

/** Test double that records everything it would have sent. */
export class RecordingAnnouncer implements Announcer {
  public readonly sent: Array<{ draftId: number; payload: AnnouncementPayload }> = [];
  public readonly updates: Array<{ ref: AnnouncementRef; payload: AnnouncementPayload }> = [];
  async announce(draft: Draft, payload: AnnouncementPayload): Promise<AnnouncementRef | null> {
    this.sent.push({ draftId: draft.id, payload });
    return { channelId: draft.channelId ?? 'none', messageId: `msg-${this.sent.length}` };
  }
  async update(ref: AnnouncementRef, payload: AnnouncementPayload): Promise<void> {
    this.updates.push({ ref, payload });
  }
}

export const Colors = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x99aab5,
} as const;
