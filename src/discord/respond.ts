import { MessageFlags, type ChatInputCommandInteraction, type InteractionEditReplyOptions, type InteractionReplyOptions, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';
import { isDraftError } from '../domain/errors.js';
import type { Logger } from '../logging/logger.js';
import type { AnnouncementPayload } from '../services/announcer.js';
import { toButtons, toEmbed } from './announcer.js';

export type RepliableInteraction = ChatInputCommandInteraction<'cached'> | MessageComponentInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

export interface SendOptions {
  ephemeral?: boolean;
}

function build(payload: AnnouncementPayload): InteractionEditReplyOptions & { content: string } {
  return {
    content: payload.content?.slice(0, 2000) ?? '',
    embeds: payload.embeds?.map(toEmbed) ?? [],
    components: payload.buttons?.length ? toButtons(payload.buttons) : [],
    allowedMentions: { parse: [], users: payload.mentionUserIds ?? [] },
  };
}

/** Replies, edits the deferred reply, or follows up, whichever applies. */
export async function send(interaction: RepliableInteraction, payload: AnnouncementPayload, opts: SendOptions = {}): Promise<void> {
  const body = build(payload);
  if (interaction.deferred) {
    await interaction.editReply(body);
    return;
  }
  const replyBody: InteractionReplyOptions = { ...body, flags: opts.ephemeral ? MessageFlags.Ephemeral : undefined };
  if (interaction.replied) {
    await interaction.followUp(replyBody);
    return;
  }
  await interaction.reply(replyBody);
}

export async function sendText(interaction: RepliableInteraction, content: string, opts: SendOptions = {}): Promise<void> {
  await send(interaction, { content }, opts);
}

export async function sendError(interaction: RepliableInteraction, err: unknown, logger: Logger): Promise<void> {
  const message = isDraftError(err) ? `❌ ${err.message}` : '❌ Something went wrong while handling that command. The error has been logged.';
  if (!isDraftError(err)) logger.error({ err, command: interaction.isChatInputCommand() ? interaction.commandName : interaction.customId }, 'interaction failed');
  try {
    if (interaction.deferred) await interaction.editReply({ content: message, embeds: [], components: [] });
    else if (interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  } catch (replyErr) {
    logger.warn({ err: replyErr }, 'could not deliver error reply');
  }
}

export async function defer(interaction: RepliableInteraction, ephemeral = false): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  }
}

/** Updates the message a component interaction came from. */
export async function updateMessage(interaction: MessageComponentInteraction<'cached'>, payload: AnnouncementPayload): Promise<void> {
  const body = build(payload);
  if (interaction.deferred || interaction.replied) await interaction.editReply(body);
  else await interaction.update(body);
}
