import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type SlashCommandStringOption } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import { normalizeTeamNumber } from '../../engine/draftEngine.js';
import type { BotContext, Command } from '../context.js';
import { actorFor, participantChoices, requireOpenDraft, resolveUserSeat, respondAutocomplete, teamChoices } from '../permissions.js';
import { send, sendText } from '../respond.js';
import { prepicksEmbed } from '../views/index.js';

const seatOption = (o: SlashCommandStringOption) => o.setName('seat').setDescription('Which of your seats (only if you control several)').setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('prepicks')
  .setDescription('Manage the teams the bot should pick for you automatically')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add a team to your prepick list')
      .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('position').setDescription('Insert at this position (default: end)').setMinValue(1))
      .addStringOption(seatOption),
  )
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a team from your prepick list').addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true)).addStringOption(seatOption))
  .addSubcommand((s) => s.setName('view').setDescription('Show your prepick list').addStringOption(seatOption))
  .addSubcommand((s) =>
    s
      .setName('reorder')
      .setDescription('Reorder your list: give team numbers in priority order')
      .addStringOption((o) => o.setName('order').setDescription('e.g. "1234A, 5678B, 910C" (unlisted teams keep their order after these)').setRequired(true))
      .addStringOption(seatOption),
  )
  .addSubcommand((s) => s.setName('clear').setDescription('Remove all your prepicks').addStringOption(seatOption));

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireOpenDraft(ctx, interaction.guildId);
  const seat = resolveUserSeat(ctx, draft, interaction.user.id, interaction.options.getString('seat'));
  const actor = actorFor(interaction, ctx);
  const sub = interaction.options.getSubcommand();
  const { prepicks, repos } = ctx.service;
  const teamFor = (raw: string) => {
    const t = repos.teams.getByNumber(draft.id, normalizeTeamNumber(raw));
    if (!t) throw new DraftError('TEAM_NOT_FOUND', `Team ${normalizeTeamNumber(raw)} is not in this draft.`);
    return t;
  };
  await ctx.service.withDraftLock(draft.id, async () => {
    switch (sub) {
      case 'add': {
        const team = teamFor(interaction.options.getString('team', true));
        const position = interaction.options.getInteger('position') ?? undefined;
        const list = prepicks.add(draft.id, seat.id, team.id, actor, position);
        await send(interaction, { content: `✅ Added **${team.teamNumber}** to your prepicks.`, embeds: [prepicksEmbed(seat, list)] }, { ephemeral: true });
        return;
      }
      case 'remove': {
        const team = teamFor(interaction.options.getString('team', true));
        const list = prepicks.remove(draft.id, seat.id, team.id, actor);
        await send(interaction, { content: `✅ Removed **${team.teamNumber}** from your prepicks.`, embeds: [prepicksEmbed(seat, list)] }, { ephemeral: true });
        return;
      }
      case 'view':
        await send(interaction, { embeds: [prepicksEmbed(seat, prepicks.list(draft.id, seat.id))] }, { ephemeral: true });
        return;
      case 'reorder': {
        const numbers = interaction.options.getString('order', true).split(/[,\s]+/).map((n) => n.trim()).filter(Boolean);
        if (numbers.length === 0) throw new DraftError('VALIDATION', 'List at least one team number.');
        const list = prepicks.reorder(draft.id, seat.id, numbers.map((n) => teamFor(n).id), actor);
        await send(interaction, { content: '✅ Prepicks reordered.', embeds: [prepicksEmbed(seat, list)] }, { ephemeral: true });
        return;
      }
      case 'clear': {
        const removed = prepicks.clear(draft.id, seat.id, actor);
        await sendText(interaction, `✅ Cleared ${removed} prepick(s).`, { ephemeral: true });
        return;
      }
      default:
        throw new DraftError('VALIDATION', 'Unknown subcommand.');
    }
  });
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getOpenForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  const focused = interaction.options.getFocused(true);
  const q = String(focused.value);
  if (focused.name === 'seat') {
    const mine = new Set(ctx.service.repos.participants.listSeatsForUser(draft.id, interaction.user.id).map((s) => `id:${s.id}`));
    return respondAutocomplete(interaction, participantChoices(ctx, draft, q).filter((c) => mine.has(c.value)));
  }
  if (interaction.options.getSubcommand(false) === 'remove') {
    try {
      const seat = resolveUserSeat(ctx, draft, interaction.user.id, interaction.options.getString('seat'));
      const entries = ctx.service.prepicks.list(draft.id, seat.id).filter((e) => e.team.teamNumber.includes(q.toUpperCase()));
      return respondAutocomplete(interaction, entries.map((e) => ({ name: `${e.team.teamNumber}${e.team.teamName ? ` — ${e.team.teamName}` : ''}`, value: e.team.teamNumber })));
    } catch {
      return respondAutocomplete(interaction, []);
    }
  }
  return respondAutocomplete(interaction, teamChoices(ctx, draft, q, 'available'));
}

export const prepicksCommand: Command = { data: data.toJSON(), execute, autocomplete };
