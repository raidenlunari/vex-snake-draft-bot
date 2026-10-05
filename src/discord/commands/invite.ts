import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { Colors } from '../../services/announcer.js';
import { customId, type BotContext, type Command } from '../context.js';
import { actorFor, participantChoices, requireCurrentDraft, resolveUserSeat, respondAutocomplete } from '../permissions.js';
import { send } from '../respond.js';

const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Invite someone to join your seat so they can pick and trade with you')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Who to invite').setRequired(true))
  .addStringOption((o) => o.setName('seat').setDescription('Which of your seats (only if you control several)').setAutocomplete(true));

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const seat = resolveUserSeat(ctx, draft, interaction.user.id, interaction.options.getString('seat'));
  const invitee = interaction.options.getUser('user', true);
  ctx.service.engine.inviteToSeat(draft.id, seat.id, invitee.id, actorFor(interaction, ctx));
  await send(interaction, {
    content: `📨 <@${invitee.id}>, <@${interaction.user.id}> invited you to join **${seat.label}** in the ${draft.name} draft.`,
    embeds: [{ description: 'Accepting lets you pick, prepick, swap and trade for this seat, and you will be pinged on its turn.', color: Colors.info }],
    buttons: [
      { id: customId('invite', 'accept', draft.id, seat.id, invitee.id), label: 'Accept', style: 'success', emoji: '✅' },
      { id: customId('invite', 'decline', draft.id, seat.id, invitee.id), label: 'Decline', style: 'secondary' },
    ],
    mentionUserIds: [invitee.id],
  });
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  const mine = new Set(ctx.service.repos.participants.listSeatsForUser(draft.id, interaction.user.id).map((s) => `id:${s.id}`));
  return respondAutocomplete(interaction, participantChoices(ctx, draft, String(interaction.options.getFocused())).filter((c) => mine.has(c.value)));
}

export const inviteCommand: Command = { data: data.toJSON(), execute, autocomplete };
