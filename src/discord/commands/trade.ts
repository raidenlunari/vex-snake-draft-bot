import { InteractionContextType, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import type { Draft } from '../../domain/types.js';
import type { TradeResolution } from '../../engine/tradeEngine.js';
import type { BotContext, Command } from '../context.js';
import { actorFor, isDraftAdmin, participantChoices, requireCurrentDraft, resolveParticipantRef, resolveUserSeat, respondAutocomplete } from '../permissions.js';
import { defer, send, sendText } from '../respond.js';
import { tradeButtons, tradeEmbed, tradeMentions } from '../views/index.js';
import { refreshTradeMessage } from './draft.js';

const data = new SlashCommandBuilder()
  .setName('trade')
  .setDescription('Propose and answer trades')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('propose')
      .setDescription('Propose a trade to another participant')
      .addStringOption((o) => o.setName('with').setDescription('The other participant').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('give').setDescription('What you give: team numbers, R3 (round-3 pick) or #17, comma separated').setRequired(true))
      .addStringOption((o) => o.setName('receive').setDescription('What you receive, same format').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Optional message').setMaxLength(200))
      .addStringOption((o) => o.setName('seat').setDescription('Which of your seats proposes (if you control several)').setAutocomplete(true)),
  )
  .addSubcommand((s) => s.setName('accept').setDescription('Accept a trade proposed to you').addIntegerOption((o) => o.setName('id').setDescription('Trade id').setRequired(true)))
  .addSubcommand((s) => s.setName('reject').setDescription('Reject a trade proposed to you').addIntegerOption((o) => o.setName('id').setDescription('Trade id').setRequired(true)))
  .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a trade you are part of').addIntegerOption((o) => o.setName('id').setDescription('Trade id').setRequired(true)))
  .addSubcommand((s) => s.setName('view').setDescription('Show a trade').addIntegerOption((o) => o.setName('id').setDescription('Trade id').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('List pending trades'));

function splitRefs(text: string): string[] {
  return text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Human-readable outcome of a trade response or admin decision. */
export function describeResolution(id: number, action: 'accept' | 'reject' | 'approve' | 'deny', result: TradeResolution): string {
  if (action === 'reject') return `❌ Trade #${id} rejected.`;
  if (action === 'deny') return `⛔ Trade #${id} denied.`;
  if (result.failure) return `⚠️ Trade #${id} could not be executed: ${result.failure}`;
  if (result.executed) return `✅ Trade #${id} ${action === 'approve' ? 'approved and ' : 'accepted and '}executed.`;
  if (result.awaitingAdmin) return `✅ Trade #${id} accepted; waiting for an admin to approve it.`;
  return `Trade #${id} updated.`;
}

/** Posts a trade in the draft channel with action buttons and stores the message id. */
export async function postTradeMessage(ctx: BotContext, draft: Draft, tradeId: number): Promise<void> {
  const config = ctx.service.repos.drafts.getConfig(draft.id);
  const view = ctx.service.trades.view(draft.id, tradeId);
  const payload = {
    content: view.trade.status === 'proposed' ? `🤝 ${view.counterparty.users.map((u) => `<@${u.discordUserId}>`).join(' ')} — **${view.proposer.label}** proposed trade #${view.trade.id}.` : `🤝 Trade #${view.trade.id}`,
    embeds: [tradeEmbed(view)],
    buttons: tradeButtons(draft.id, view, config.tradeApproval),
    mentionUserIds: tradeMentions(view),
  };
  const ref = await ctx.service.announcer.announce(draft, payload);
  if (ref) ctx.service.repos.trades.setMessage(view.trade.id, ref.channelId, ref.messageId);
}

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const sub = interaction.options.getSubcommand();
  const actor = actorFor(interaction, ctx);
  const { service } = ctx;
  const config = service.repos.drafts.getConfig(draft.id);

  if (sub === 'list') {
    const open = service.trades.listOpen(draft.id);
    await send(interaction, { content: open.length ? `${open.length} pending trade(s):` : 'No pending trades.', embeds: open.slice(0, 10).map(tradeEmbed) }, { ephemeral: true });
    return;
  }
  if (sub === 'view') {
    const view = service.trades.view(draft.id, interaction.options.getInteger('id', true));
    await send(interaction, { embeds: [tradeEmbed(view)] }, { ephemeral: true });
    return;
  }
  if (sub === 'propose') {
    const proposer = resolveUserSeat(ctx, draft, interaction.user.id, interaction.options.getString('seat'));
    const counterparty = resolveParticipantRef(ctx, draft, interaction.options.getString('with', true));
    const give = service.trades.resolveAssetRefs(draft.id, proposer.id, splitRefs(interaction.options.getString('give', true)));
    const receive = service.trades.resolveAssetRefs(draft.id, counterparty.id, splitRefs(interaction.options.getString('receive', true)));
    await defer(interaction, true);
    const { view, failure } = await service.proposeTrade(draft.id, { proposerParticipantId: proposer.id, counterpartyParticipantId: counterparty.id, giveAssetIds: give, receiveAssetIds: receive, actor, note: interaction.options.getString('note') });
    await postTradeMessage(ctx, draft, view.trade.id);
    const text = failure
      ? `⚠️ Trade #${view.trade.id} could not be executed: ${failure}`
      : view.trade.status === 'executed'
        ? `✅ Trade #${view.trade.id} executed.`
        : `📨 Trade #${view.trade.id} proposed. ${counterparty.label} can accept with the buttons in <#${draft.channelId}> or \`/trade accept id:${view.trade.id}\`.`;
    await send(interaction, { content: text, embeds: [tradeEmbed(service.trades.view(draft.id, view.trade.id))] });
    return;
  }
  const id = interaction.options.getInteger('id', true);
  await defer(interaction, true);
  if (sub === 'accept' || sub === 'reject') {
    const result = await service.respondTrade(draft.id, id, sub === 'accept', actor);
    await refreshTradeMessage(ctx, draft.id, id, config.tradeApproval);
    await send(interaction, { content: describeResolution(id, sub === 'reject' ? 'reject' : 'accept', result), embeds: [tradeEmbed(result.view)] });
    return;
  }
  if (sub === 'cancel') {
    const view = await service.cancelTrade(draft.id, id, isDraftAdmin(interaction, ctx) ? { id: interaction.user.id, kind: 'admin' } : actor);
    await refreshTradeMessage(ctx, draft.id, id, config.tradeApproval);
    await sendText(interaction, `🚫 Trade #${view.trade.id} cancelled.`);
    return;
  }
  throw new DraftError('VALIDATION', 'Unknown subcommand.');
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  const focused = interaction.options.getFocused(true);
  const choices = participantChoices(ctx, draft, String(focused.value));
  if (focused.name === 'seat') {
    const mine = new Set(ctx.service.repos.participants.listSeatsForUser(draft.id, interaction.user.id).map((s) => `id:${s.id}`));
    return respondAutocomplete(interaction, choices.filter((c) => mine.has(c.value)));
  }
  return respondAutocomplete(interaction, choices);
}

export const tradeCommand: Command = { data: data.toJSON(), execute, autocomplete };
