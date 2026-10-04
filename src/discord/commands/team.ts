import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { normalizeTeamNumber } from '../../engine/draftEngine.js';
import { Colors } from '../../services/announcer.js';
import type { BotContext, Command } from '../context.js';
import { requireCurrentDraft, respondAutocomplete, teamChoices } from '../permissions.js';
import { send } from '../respond.js';
import { teamEmbed } from '../views/index.js';

const data = new SlashCommandBuilder()
  .setName('team')
  .setDescription('Look up a VEX team in the draft')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('number').setDescription('Team number, e.g. 12345A').setRequired(true).setAutocomplete(true));

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const raw = interaction.options.getString('number', true);
  const number = normalizeTeamNumber(raw);
  const team = ctx.service.repos.teams.getByNumber(draft.id, number);
  if (!team) {
    const similar = ctx.service.repos.teams.search(draft.id, number.replace(/[A-Z]$/, ''), 8);
    await send(
      interaction,
      {
        embeds: [
          {
            title: `Team ${number}`,
            description: `**Exists in this draft:** No${similar.length ? `\n\nDid you mean: ${similar.map((t) => `\`${t.teamNumber}\``).join(', ')}?` : ''}`,
            color: Colors.danger,
          },
        ],
      },
      { ephemeral: true },
    );
    return;
  }
  await send(interaction, { embeds: [teamEmbed(ctx.service.engine.getTeamInfo(draft.id, team.id))] });
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  return respondAutocomplete(interaction, teamChoices(ctx, draft, String(interaction.options.getFocused()), 'all'));
}

export const teamCommand: Command = { data: data.toJSON(), execute, autocomplete };
