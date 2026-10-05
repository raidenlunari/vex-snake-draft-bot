import { InteractionContextType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Draft } from '../../domain/types.js';
import type { BotContext, Command } from '../context.js';
import { requireCurrentDraft } from '../permissions.js';
import { send } from '../respond.js';
import { availableTeamsButtons, availableTeamsEmbed, teamsPageCount, type TeamsMode } from '../views/teams.js';
import type { AnnouncementPayload } from '../../services/announcer.js';

const data = new SlashCommandBuilder()
  .setName('teams')
  .setDescription('Show the teams still available to pick')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('filter').setDescription('Only teams whose number, name or school contains this').setMaxLength(30))
  .addBooleanOption((o) => o.setName('names').setDescription('List names and schools instead of the number grid'));

/** Builds the paged "available teams" message; shared by the command and its buttons. */
export function availableTeamsPayload(ctx: BotContext, draft: Draft, page: number, mode: TeamsMode, filter: string | null): AnnouncementPayload {
  const repos = ctx.service.repos;
  const config = repos.drafts.getConfig(draft.id);
  const teams = repos.teams.listAvailableWithCounts(draft.id, config.maxInstancesPerTeam, filter ?? undefined);
  const pages = teamsPageCount(teams.length, mode);
  const current = Math.min(Math.max(page, 0), pages - 1);
  return {
    embeds: [availableTeamsEmbed(draft, teams, repos.teams.count(draft.id), current, mode, filter)],
    buttons: filter ? [] : availableTeamsButtons(draft.id, current, pages, mode),
  };
}

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const draft = requireCurrentDraft(ctx, interaction.guildId);
  const filter = interaction.options.getString('filter')?.trim() || null;
  const mode: TeamsMode = interaction.options.getBoolean('names') ? 'names' : 'grid';
  await send(interaction, availableTeamsPayload(ctx, draft, 0, mode, filter));
}

export const teamsCommand: Command = { data: data.toJSON(), execute };
