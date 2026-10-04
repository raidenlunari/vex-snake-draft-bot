import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import type { ParticipantWithUsers } from '../../domain/types.js';
import { normalizeTeamNumber } from '../../engine/draftEngine.js';
import { Colors } from '../../services/announcer.js';
import { customId, type BotContext, type Command } from '../context.js';
import { actorFor, participantChoices, requireActiveDraft, resolveParticipantRef, respondAutocomplete, teamChoices } from '../permissions.js';
import { defer, send, sendText } from '../respond.js';
import { seatName, teamLabel } from '../views/index.js';

const data = new SlashCommandBuilder()
  .setName('pick')
  .setDescription('Select a team when it is your turn (or to fill a skipped pick)')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('seat').setDescription('Which of your seats (only if you control several)').setAutocomplete(true));

/**
 * Decides which seat the user is picking for: the seat on the clock if they belong to
 * it, otherwise a seat of theirs with an open catch-up pick.
 */
export function resolvePickingSeat(ctx: BotContext, draftId: number, userId: string, seatOption: string | null): ParticipantWithUsers {
  const repos = ctx.service.repos;
  const draft = repos.drafts.getById(draftId);
  if (!draft) throw new DraftError('DRAFT_NOT_FOUND', 'That draft no longer exists.');
  const seats = repos.participants.listSeatsForUser(draftId, userId);
  if (seats.length === 0) throw new DraftError('NOT_PARTICIPANT', 'You are not registered as a participant in this draft. Ask an admin to add you with `/draft participant add`.');
  if (seatOption) {
    const seat = resolveParticipantRef(ctx, draft, seatOption);
    if (!seats.some((s) => s.id === seat.id)) throw new DraftError('PERMISSION_DENIED', `You are not a member of "${seat.label}".`);
    return seat;
  }
  const turn = ctx.service.engine.currentTurn(draftId);
  if (turn && seats.some((s) => s.id === turn.owner.id)) return turn.owner;
  const catchUp = ctx.service.engine.catchUpSeatsForUser(draftId, userId);
  if (catchUp.length === 1) return catchUp[0] as ParticipantWithUsers;
  if (catchUp.length > 1) throw new DraftError('VALIDATION', `Several of your seats have open catch-up picks (${catchUp.map((s) => s.label).join(', ')}). Add the \`seat\` option.`);
  if (turn) throw new DraftError('NOT_YOUR_TURN', `You can't pick right now. It is ${seatName(turn.owner)}'s turn.`);
  throw new DraftError('NOT_YOUR_TURN', 'There is no open pick for you right now.');
}

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireActiveDraft(ctx, interaction.guildId);
  const teamNumber = normalizeTeamNumber(interaction.options.getString('team', true));
  const team = ctx.service.repos.teams.getByNumber(draft.id, teamNumber);
  if (!team) throw new DraftError('TEAM_NOT_FOUND', `Team ${teamNumber} is not in this draft. Check the number or use the autocomplete list.`);
  const seat = resolvePickingSeat(ctx, draft.id, interaction.user.id, interaction.options.getString('seat'));
  const config = ctx.service.repos.drafts.getConfig(draft.id);
  // Early, friendly availability check (the engine re-validates inside the transaction).
  const info = ctx.service.engine.getTeamInfo(draft.id, team.id);
  if (!info.available) {
    const first = info.owners[0];
    throw new DraftError(
      'TEAM_UNAVAILABLE',
      info.removed
        ? `Team ${team.teamNumber} has been removed from this draft.`
        : first
          ? `Team ${team.teamNumber} is no longer available. It was selected by ${seatName(first.participant)}${first.overallPick ? ` at overall pick #${first.overallPick}` : ''}.`
          : `Team ${team.teamNumber} is no longer available.`,
    );
  }
  if (config.requirePickConfirmation) {
    await send(
      interaction,
      {
        embeds: [{ title: 'Confirm your pick', description: `${teamLabel(team)}${team.organization ? `\n${team.organization}` : ''}${team.location ? ` · ${team.location}` : ''}\n\nPicking for **${seat.label}**.`, color: Colors.info }],
        buttons: [
          { id: customId('pick', 'confirm', draft.id, seat.id, team.id), label: `Pick ${team.teamNumber}`, style: 'success', emoji: '✅' },
          { id: customId('pick', 'cancel', draft.id), label: 'Cancel', style: 'secondary' },
        ],
      },
      { ephemeral: true },
    );
    return;
  }
  await defer(interaction, true);
  const events = await ctx.service.pick(draft.id, { participantId: seat.id, teamId: team.id, actor: actorFor(interaction, ctx) });
  const made = events.find((e) => e.type === 'pick_made');
  const where = made && made.type === 'pick_made' && made.slot ? ` as pick #${made.slot.overallPick}` : '';
  await sendText(interaction, `✅ You picked **${team.teamNumber}**${where}. ${draft.channelId ? `Announced in <#${draft.channelId}>.` : ''}`);
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getOpenForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'seat') {
    const mine = new Set(ctx.service.repos.participants.listSeatsForUser(draft.id, interaction.user.id).map((s) => `id:${s.id}`));
    return respondAutocomplete(interaction, participantChoices(ctx, draft, String(focused.value)).filter((c) => mine.has(c.value)));
  }
  return respondAutocomplete(interaction, teamChoices(ctx, draft, String(focused.value), 'available'));
}

export const pickCommand: Command = { data: data.toJSON(), execute, autocomplete };
