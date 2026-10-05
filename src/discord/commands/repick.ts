import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import { normalizeTeamNumber } from '../../engine/draftEngine.js';
import type { BotContext, Command } from '../context.js';
import { actorFor, requireCurrentDraft, respondAutocomplete, teamChoices } from '../permissions.js';
import { defer, send, sendText } from '../respond.js';
import { repickEmbed } from '../views/index.js';

const data = new SlashCommandBuilder()
  .setName('repick')
  .setDescription('Answer a repick an admin opened for your team')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('choose')
      .setDescription('Choose the replacement team')
      .addStringOption((o) => o.setName('team').setDescription('Replacement team number').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('id').setDescription('Repick id (only if you have several open)')),
  )
  .addSubcommand((s) => s.setName('view').setDescription('Show your open repicks'));

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const mine = ctx.service.repicks.openForUser(draft.id, interaction.user.id);
  if (sub === 'view') {
    await send(interaction, { content: mine.length ? '' : 'You have no open repicks.', embeds: mine.map(repickEmbed) }, { ephemeral: true });
    return;
  }
  if (mine.length === 0) throw new DraftError('VALIDATION', 'You have no open repick. An admin opens one with `/draft repick start` when a team no-shows.');
  const id = interaction.options.getInteger('id');
  const target = id ? mine.find((r) => r.repick.id === id) : mine.length === 1 ? mine[0] : null;
  if (!target) throw new DraftError('VALIDATION', `Specify which repick: ${mine.map((r) => `#${r.repick.id} (${r.participant.label})`).join(', ')}.`);
  const number = normalizeTeamNumber(interaction.options.getString('team', true));
  const team = ctx.service.repos.teams.getByNumber(draft.id, number);
  if (!team) throw new DraftError('TEAM_NOT_FOUND', `Team ${number} is not in this draft.`);
  await defer(interaction, true);
  const view = await ctx.service.proposeRepick(draft.id, target.repick.id, team.id, actorFor(interaction, ctx));
  await sendText(interaction, `🔁 You chose **${team.teamNumber}** to replace ${view.oldTeam.teamNumber} (repick #${view.repick.id}). An admin needs to approve it.`);
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  return respondAutocomplete(interaction, teamChoices(ctx, draft, String(interaction.options.getFocused()), 'available'));
}

export const repickCommand: Command = { data: data.toJSON(), execute, autocomplete };
