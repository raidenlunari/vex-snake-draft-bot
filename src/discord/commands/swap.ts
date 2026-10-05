import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import { normalizeTeamNumber } from '../../engine/draftEngine.js';
import type { BotContext, Command } from '../context.js';
import { actorFor, participantChoices, requireCurrentDraft, resolveUserSeat, respondAutocomplete, rosterTeamChoices, teamChoices } from '../permissions.js';
import { defer, sendText } from '../respond.js';

const data = new SlashCommandBuilder()
  .setName('swap')
  .setDescription('Swap one of your teams for a team nobody has picked')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('old-team').setDescription('Team on your roster to give up').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('new-team').setDescription('Unpicked team you want instead').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('seat').setDescription('Which of your seats (only if you control several)').setAutocomplete(true));

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const seat = resolveUserSeat(ctx, draft, interaction.user.id, interaction.options.getString('seat'));
  const teamFor = (raw: string) => {
    const t = ctx.service.repos.teams.getByNumber(draft.id, normalizeTeamNumber(raw));
    if (!t) throw new DraftError('TEAM_NOT_FOUND', `Team ${normalizeTeamNumber(raw)} is not in this draft.`);
    return t;
  };
  const oldTeam = teamFor(interaction.options.getString('old-team', true));
  const newTeam = teamFor(interaction.options.getString('new-team', true));
  await defer(interaction, true);
  await ctx.service.swapTeam(draft.id, { participantId: seat.id, oldTeamId: oldTeam.id, newTeamId: newTeam.id, actor: actorFor(interaction, ctx) });
  await sendText(interaction, `🔄 Swapped **${oldTeam.teamNumber}** for **${newTeam.teamNumber}**.`);
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  const focused = interaction.options.getFocused(true);
  const q = String(focused.value);
  if (focused.name === 'seat') {
    const mine = new Set(ctx.service.repos.participants.listSeatsForUser(draft.id, interaction.user.id).map((s) => `id:${s.id}`));
    return respondAutocomplete(interaction, participantChoices(ctx, draft, q).filter((c) => mine.has(c.value)));
  }
  if (focused.name === 'old-team') {
    try {
      const seat = resolveUserSeat(ctx, draft, interaction.user.id, interaction.options.getString('seat'));
      return respondAutocomplete(interaction, rosterTeamChoices(ctx, draft, seat.id, q));
    } catch {
      return respondAutocomplete(interaction, []);
    }
  }
  return respondAutocomplete(interaction, teamChoices(ctx, draft, q, 'available'));
}

export const swapCommand: Command = { data: data.toJSON(), execute, autocomplete };
