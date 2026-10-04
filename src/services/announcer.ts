import type { Draft } from '../domain/types.js';

/** Discord-agnostic message payload rendered by the announcer implementation. */
export interface EmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface AnnouncementPayload {
  content?: string;
  embeds?: EmbedPayload[];
  /** Discord user ids allowed to be pinged by this message. */
  mentionUserIds?: string[];
}

export interface Announcer {
  announce(draft: Draft, payload: AnnouncementPayload): Promise<void>;
}

export class NoopAnnouncer implements Announcer {
  async announce(): Promise<void> {
    /* intentionally empty */
  }
}

/** Test double that records everything it would have sent. */
export class RecordingAnnouncer implements Announcer {
  public readonly sent: Array<{ draftId: number; payload: AnnouncementPayload }> = [];
  async announce(draft: Draft, payload: AnnouncementPayload): Promise<void> {
    this.sent.push({ draftId: draft.id, payload });
  }
}

export const Colors = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x99aab5,
} as const;
