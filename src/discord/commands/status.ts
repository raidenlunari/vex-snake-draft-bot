import { InteractionContextType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { BotContext, Command } from '../context.js';
import { requireCurrentDraft } from '../permissions.js';
import { send } from '../respond.js';
import { statusButtons, statusEmbed } from '../views/index.js';

const data = new SlashCommandBuilder().setName('status').setDescription('Show the current state of the draft').setContexts(InteractionContextType.Guild);

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const state = ctx.service.engine.getState(draft.id);
  await send(interaction, { embeds: [statusEmbed(state, new Date().toISOString())], buttons: statusButtons(draft.id) });
}

export const statusCommand: Command = { data: data.toJSON(), execute };
