import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Client,
  type MessageCreateOptions,
  type MessageEditOptions,
  type SendableChannels,
} from 'discord.js';
import type { Draft } from '../domain/types.js';
import type { Logger } from '../logging/logger.js';
import type { AnnouncementPayload, AnnouncementRef, Announcer, ButtonSpec, EmbedPayload } from '../services/announcer.js';

const STYLE: Record<NonNullable<ButtonSpec['style']>, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export function toEmbed(e: EmbedPayload): EmbedBuilder {
  const b = new EmbedBuilder();
  if (e.title) b.setTitle(e.title.slice(0, 256));
  if (e.description) b.setDescription(e.description.slice(0, 4096));
  if (e.color !== undefined) b.setColor(e.color);
  if (e.fields?.length) b.addFields(e.fields.slice(0, 25).map((f) => ({ name: f.name.slice(0, 256), value: (f.value || '—').slice(0, 1024), inline: f.inline ?? false })));
  if (e.footer) b.setFooter({ text: e.footer.slice(0, 2048) });
  return b;
}

export function toButtons(buttons: ButtonSpec[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const b of buttons.slice(i, i + 5)) {
      const builder = new ButtonBuilder().setCustomId(b.id).setLabel(b.label.slice(0, 80)).setStyle(STYLE[b.style ?? 'secondary']);
      if (b.emoji) builder.setEmoji(b.emoji);
      row.addComponents(builder);
    }
    rows.push(row);
  }
  return rows;
}

export function toMessageOptions(payload: AnnouncementPayload): MessageCreateOptions & MessageEditOptions {
  return {
    content: payload.content?.slice(0, 2000) ?? '',
    embeds: payload.embeds?.map(toEmbed) ?? [],
    components: payload.buttons?.length ? toButtons(payload.buttons) : [],
    allowedMentions: { parse: [], users: [...new Set(payload.mentionUserIds ?? [])].slice(0, 100) },
  };
}

/**
 * Sends announcements to the draft's configured channel. Supports text channels,
 * threads and forum posts (which are threads); archived threads are reopened first.
 */
export class DiscordAnnouncer implements Announcer {
  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  async announce(draft: Draft, payload: AnnouncementPayload): Promise<AnnouncementRef | null> {
    if (!draft.channelId) {
      this.logger.warn({ draftId: draft.id }, 'draft has no channel; announcement dropped');
      return null;
    }
    const channel = await this.resolveChannel(draft.channelId);
    if (!channel) {
      this.logger.warn({ draftId: draft.id, channelId: draft.channelId }, 'draft channel not found or not sendable');
      return null;
    }
    const message = await channel.send(toMessageOptions(payload));
    return { channelId: channel.id, messageId: message.id };
  }

  async update(ref: AnnouncementRef, payload: AnnouncementPayload): Promise<void> {
    const channel = await this.resolveChannel(ref.channelId);
    if (!channel) return;
    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) return;
    await message.edit(toMessageOptions(payload));
  }

  private async resolveChannel(channelId: string): Promise<SendableChannels | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    if (channel.isThread()) {
      if (channel.archived) {
        try {
          await channel.setArchived(false, 'Draft announcement');
        } catch (err) {
          this.logger.warn({ err, channelId }, 'could not unarchive draft thread');
        }
      }
      if (channel.locked) {
        this.logger.warn({ channelId }, 'draft thread is locked');
        return null;
      }
      return channel;
    }
    if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
      this.logger.warn({ channelId }, 'draft channel is a forum; a post must be selected with /draft channel set');
      return null;
    }
    if (!channel.isSendable()) return null;
    return channel;
  }
}
