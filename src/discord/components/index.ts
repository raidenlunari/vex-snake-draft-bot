import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { DraftError } from '../../domain/errors.js';
import { Colors } from '../../services/announcer.js';
import type { BotContext, ComponentHandler } from '../context.js';
import { actorFor, isDraftAdmin, requireAdmin, requireCurrentDraft, requireOpenDraft, resolveUserSeat } from '../permissions.js';
import { defer, send, updateMessage } from '../respond.js';
import { fullOrderEmbed, orderEmbed, prepicksEmbed, repickEmbed, rosterEmbed, allRostersEmbed, seatName, statusButtons, statusEmbed, tradeEmbed } from '../views/index.js';
import { refreshTradeMessage } from '../commands/draft.js';
import { describeResolution } from '../commands/trade.js';
import { availableTeamsPayload } from '../commands/teams.js';
import type { TeamsMode } from '../views/teams.js';

type Interaction = MessageComponentInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

function num(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new DraftError('VALIDATION', `Invalid ${what}.`);
  return n;
}

function requireDraftId(ctx: BotContext, interaction: Interaction, raw: string | undefined): number {
  const draftId = num(raw, 'draft id');
  const draft = ctx.service.repos.drafts.getById(draftId);
  if (!draft || draft.guildId !== interaction.guildId) throw new DraftError('DRAFT_NOT_FOUND', 'That draft no longer exists.');
  return draftId;
}

function isComponent(i: Interaction): i is MessageComponentInteraction<'cached'> {
  return i.isMessageComponent();
}

const pickHandler: ComponentHandler = {
  namespace: 'pick',
  async execute(interaction, args, ctx) {
    const [action] = args;
    if (action === 'cancel') {
      if (isComponent(interaction)) await updateMessage(interaction, { content: 'Pick cancelled.', embeds: [], buttons: [] });
      return;
    }
    const draftId = requireDraftId(ctx, interaction, args[1]);
    const participantId = num(args[2], 'participant');
    const teamId = num(args[3], 'team');
    const draft = requireOpenDraft(ctx, interaction.guildId);
    if (draft.id !== draftId) throw new DraftError('STALE', 'That confirmation belongs to an older draft.');
    // Only a member of the seat may confirm; the engine re-checks as well.
    if (!ctx.service.repos.participants.isMember(participantId, interaction.user.id) && !isDraftAdmin(interaction, ctx)) {
      throw new DraftError('PERMISSION_DENIED', 'Only the player who started this pick can confirm it.');
    }
    const team = ctx.service.repos.teams.getById(teamId);
    if (!team) throw new DraftError('TEAM_NOT_FOUND', 'That team no longer exists.');
    if (isComponent(interaction)) await interaction.deferUpdate();
    const events = await ctx.service.pick(draftId, { participantId, teamId, actor: actorFor(interaction, ctx) });
    const made = events.find((e) => e.type === 'pick_made');
    const where = made && made.type === 'pick_made' && made.slot ? ` as pick #${made.slot.overallPick}` : '';
    await send(interaction, { content: `✅ You picked **${team.teamNumber}**${where}.`, embeds: [], buttons: [] });
  },
};

const startHandler: ComponentHandler = {
  namespace: 'start',
  async execute(interaction, args, ctx) {
    const actor = requireAdmin(interaction, ctx);
    const [action] = args;
    const draftId = requireDraftId(ctx, interaction, args[1]);
    const draft = requireOpenDraft(ctx, interaction.guildId);
    if (draft.id !== draftId) throw new DraftError('STALE', 'That button belongs to an older draft.');
    if (action === 'cancel') {
      if (isComponent(interaction)) await updateMessage(interaction, { content: 'Start cancelled. Run `/draft start` when ready.', embeds: [], buttons: [] });
      return;
    }
    if (action === 'randomize') {
      const order = ctx.service.engine.randomize(draft.id, actor);
      const validation = ctx.service.engine.validateReadyToStart(draft.id);
      if (isComponent(interaction)) {
        await updateMessage(interaction, {
          content: '🎲 Draft order randomized again. Review it, then press **Start draft**.',
          embeds: [orderEmbed(draft, order, validation)],
          buttons: [
            { id: `start:confirm:${draft.id}`, label: 'Start draft', style: 'success', emoji: '🏁' },
            { id: `start:randomize:${draft.id}`, label: 'Re-randomize', style: 'secondary', emoji: '🎲' },
          ],
        });
      }
      return;
    }
    if (isComponent(interaction)) await interaction.deferUpdate();
    await ctx.service.start(draft.id, actor);
    const fresh = ctx.service.repos.drafts.getById(draft.id);
    await send(interaction, { content: `🏁 Draft started by <@${interaction.user.id}>. Follow along in <#${fresh?.channelId}>.`, embeds: [], buttons: [], mentionUserIds: [] });
  },
};

const completeHandler: ComponentHandler = {
  namespace: 'complete',
  async execute(interaction, args, ctx) {
    const actor = requireAdmin(interaction, ctx);
    const [action] = args;
    const draftId = requireDraftId(ctx, interaction, args[1]);
    if (action === 'cancel') {
      if (isComponent(interaction)) await updateMessage(interaction, { content: 'Cancelled.', embeds: [], buttons: [] });
      return;
    }
    if (isComponent(interaction)) await interaction.deferUpdate();
    await ctx.service.complete(draftId, actor);
    await send(interaction, { content: '🏆 The draft has been ended.', embeds: [], buttons: [] });
  },
};

const resetHandler: ComponentHandler = {
  namespace: 'reset',
  async execute(interaction, args, ctx) {
    const actor = requireAdmin(interaction, ctx);
    const [action] = args;
    const draftId = requireDraftId(ctx, interaction, args[1]);
    if (action === 'cancel') {
      if (isComponent(interaction)) await updateMessage(interaction, { content: 'Reset cancelled.', embeds: [], buttons: [] });
      return;
    }
    const purge = args[2] === '1';
    if (isComponent(interaction)) await interaction.deferUpdate();
    const result = await ctx.service.reset(draftId, actor, purge);
    await send(interaction, {
      content: `🗑️ Draft **${result.draft.name}** has been reset${purge ? ' and purged' : ' (archived)'}. You can now run \`/draft setup\` to configure a new draft.`,
      embeds: [],
      buttons: [],
    });
  },
};

const tradeHandler: ComponentHandler = {
  namespace: 'trade',
  async execute(interaction, args, ctx) {
    const [action] = args;
    const draftId = requireDraftId(ctx, interaction, args[1]);
    const tradeId = num(args[2], 'trade id');
    const draft = requireCurrentDraft(ctx, interaction.guildId);
    if (draft.id !== draftId) throw new DraftError('STALE', 'That trade belongs to an older draft.');
    const config = ctx.service.repos.drafts.getConfig(draftId);
    const { service } = ctx;
    await defer(interaction, true);
    let text: string;
    if (action === 'accept' || action === 'reject') {
      const result = await service.respondTrade(draftId, tradeId, action === 'accept', actorFor(interaction, ctx));
      text = describeResolution(tradeId, action, result);
    } else if (action === 'approve' || action === 'deny') {
      const actor = requireAdmin(interaction, ctx);
      const result = await service.adminResolveTrade(draftId, tradeId, action === 'approve', actor);
      text = describeResolution(tradeId, action, result);
    } else if (action === 'cancel') {
      await service.cancelTrade(draftId, tradeId, isDraftAdmin(interaction, ctx) ? { id: interaction.user.id, kind: 'admin' } : actorFor(interaction, ctx));
      text = `🚫 Trade #${tradeId} cancelled.`;
    } else {
      throw new DraftError('VALIDATION', 'Unknown trade action.');
    }
    await refreshTradeMessage(ctx, draftId, tradeId, config.tradeApproval);
    await send(interaction, { content: text, embeds: [tradeEmbed(service.trades.view(draftId, tradeId))] });
  },
};

const viewHandler: ComponentHandler = {
  namespace: 'view',
  async execute(interaction, args, ctx) {
    const [action] = args;
    const draftId = requireDraftId(ctx, interaction, args[1]);
    const draft = ctx.service.repos.drafts.getById(draftId)!;
    const { engine, repos, prepicks } = ctx.service;
    switch (action) {
      case 'refresh': {
        if (isComponent(interaction)) await updateMessage(interaction, { embeds: [statusEmbed(engine.getState(draftId), new Date().toISOString())], buttons: statusButtons(draftId) });
        return;
      }
      case 'roster': {
        const seats = repos.participants.listSeatsForUser(draftId, interaction.user.id);
        if (seats.length === 0) throw new DraftError('NOT_PARTICIPANT', 'You are not a participant in this draft. Use `/roster user:@someone` to look at other rosters.');
        await send(interaction, { embeds: seats.slice(0, 5).map((s) => rosterEmbed(engine.getRoster(draftId, s.id))) }, { ephemeral: true });
        return;
      }
      case 'rosters': {
        const rosters = repos.participants.listByDraft(draftId).map((p) => engine.getRoster(draftId, p.id));
        await send(interaction, { embeds: [allRostersEmbed(draft, rosters)] }, { ephemeral: true });
        return;
      }
      case 'prepicks': {
        const seat = resolveUserSeat(ctx, draft, interaction.user.id, null);
        await send(interaction, { embeds: [prepicksEmbed(seat, prepicks.list(draftId, seat.id))] }, { ephemeral: true });
        return;
      }
      case 'order': {
        if (draft.status === 'setup' || draft.status === 'randomized') {
          await send(interaction, { embeds: [orderEmbed(draft, repos.participants.listWithUsers(draftId))] }, { ephemeral: true });
          return;
        }
        await send(interaction, { embeds: [fullOrderEmbed(draft, repos.drafts.getConfig(draftId), engine.getOrder(draftId))] }, { ephemeral: true });
        return;
      }
      default:
        throw new DraftError('VALIDATION', 'Unknown view.');
    }
  },
};

const repickHandler: ComponentHandler = {
  namespace: 'repick',
  async execute(interaction, args, ctx) {
    const actor = requireAdmin(interaction, ctx);
    const [action] = args;
    const draftId = requireDraftId(ctx, interaction, args[1]);
    const repickId = num(args[2], 'repick id');
    if (action !== 'approve' && action !== 'deny') throw new DraftError('VALIDATION', 'Unknown repick action.');
    await defer(interaction, true);
    const view = await ctx.service.resolveRepick(draftId, repickId, action === 'approve', null, actor);
    await send(interaction, { content: action === 'approve' ? `✅ Repick #${repickId} approved.` : `❌ Repick #${repickId} denied; the drafter can choose again.`, embeds: [repickEmbed(view)] });
    if (isComponent(interaction)) {
      await interaction.message.edit({ components: [] }).catch(() => undefined);
    }
  },
};

const teamsHandler: ComponentHandler = {
  namespace: 'teams',
  async execute(interaction, args, ctx) {
    const draftId = requireDraftId(ctx, interaction, args[1]);
    const draft = ctx.service.repos.drafts.getById(draftId)!;
    const page = num(args[2], 'page');
    const mode: TeamsMode = args[3] === 'names' ? 'names' : 'grid';
    const payload = availableTeamsPayload(ctx, draft, page, mode, null);
    // From the status message, open a fresh ephemeral view; from a /teams message, page in place.
    if (isComponent(interaction) && interaction.message.embeds[0]?.title?.startsWith('🤖')) await updateMessage(interaction, payload);
    else await send(interaction, payload, { ephemeral: true });
  },
};

export const componentHandlers: ComponentHandler[] = [pickHandler, startHandler, completeHandler, resetHandler, tradeHandler, viewHandler, repickHandler, teamsHandler];

/** Small helper used by status replies elsewhere. */
export function describeTurn(ctx: BotContext, draftId: number): string {
  const turn = ctx.service.engine.currentTurn(draftId);
  return turn ? `${seatName(turn.owner)} is on the clock for pick #${turn.slot.overallPick}.` : 'Nobody is on the clock.';
}

export const componentColors = Colors;
