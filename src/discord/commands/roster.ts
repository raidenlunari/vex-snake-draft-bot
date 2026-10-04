import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import type { BotContext, Command } from '../context.js';
import { participantChoices, requireCurrentDraft, resolveParticipantRef, respondAutocomplete } from '../permissions.js';
import { send } from '../respond.js';
import { allRostersEmbed, rosterEmbed } from '../views/index.js';

const data = new SlashCommandBuilder()
  .setName('roster')
  .setDescription('Show a roster (yours by default)')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Show this user’s roster'))
  .addStringOption((o) => o.setName('seat').setDescription('Show this seat’s roster').setAutocomplete(true))
  .addBooleanOption((o) => o.setName('all').setDescription('Show every roster in a compact view'));

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const { engine, repos } = ctx.service;
  if (interaction.options.getBoolean('all')) {
    const rosters = repos.participants.listByDraft(draft.id).map((p) => engine.getRoster(draft.id, p.id));
    await send(interaction, { embeds: [allRostersEmbed(draft, rosters)] });
    return;
  }
  const seatRef = interaction.options.getString('seat');
  const user = interaction.options.getUser('user');
  let participantIds: number[];
  if (seatRef) participantIds = [resolveParticipantRef(ctx, draft, seatRef).id];
  else {
    const targetId = user?.id ?? interaction.user.id;
    participantIds = repos.participants.listSeatsForUser(draft.id, targetId).map((s) => s.id);
    if (participantIds.length === 0) {
      throw new DraftError('NOT_PARTICIPANT', user ? `<@${user.id}> is not a participant in this draft.` : 'You are not a participant in this draft. Use `/roster user:@someone` or `/roster all:true` to view others.');
    }
  }
  await send(interaction, { embeds: participantIds.slice(0, 5).map((id) => rosterEmbed(engine.getRoster(draft.id, id))) });
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  return respondAutocomplete(interaction, participantChoices(ctx, draft, String(interaction.options.getFocused())));
}

export const rosterCommand: Command = { data: data.toJSON(), execute, autocomplete };
