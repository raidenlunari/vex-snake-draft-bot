import { PermissionFlagsBits, type AutocompleteInteraction, type BaseInteraction, type GuildMember } from 'discord.js';
import { DraftError } from '../domain/errors.js';
import type { Actor, Draft, ParticipantWithUsers } from '../domain/types.js';
import type { BotContext } from './context.js';

/**
 * Server-side admin check. A member is a draft admin when they have Administrator or
 * Manage Server, or carry the admin role configured for the guild.
 */
export function isDraftAdmin(interaction: BaseInteraction<'cached'>, ctx: BotContext): boolean {
  const member = interaction.member as GuildMember | null;
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const settings = ctx.service.repos.drafts.getGuildSettings(interaction.guildId);
  if (settings?.adminRoleId && member.roles.cache.has(settings.adminRoleId)) return true;
  return false;
}

export function requireAdmin(interaction: BaseInteraction<'cached'>, ctx: BotContext): Actor {
  if (!isDraftAdmin(interaction, ctx)) {
    throw new DraftError('PERMISSION_DENIED', 'You need **Manage Server** permission or the configured draft admin role to do that.');
  }
  return { id: interaction.user.id, kind: 'admin' };
}

export function actorFor(interaction: BaseInteraction<'cached'>, ctx: BotContext): Actor {
  return isDraftAdmin(interaction, ctx) ? { id: interaction.user.id, kind: 'admin' } : { id: interaction.user.id, kind: 'user' };
}

/** The guild's open draft (setup/randomized/active). */
export function requireOpenDraft(ctx: BotContext, guildId: string): Draft {
  const draft = ctx.service.repos.drafts.getOpenForGuild(guildId);
  if (!draft) throw new DraftError('NO_DRAFT', 'There is no draft set up in this server. An admin can create one with `/draft setup`.');
  return draft;
}

/** The guild's latest non-archived draft (includes completed drafts, for viewing rosters afterwards). */
export function requireCurrentDraft(ctx: BotContext, guildId: string): Draft {
  const draft = ctx.service.repos.drafts.getCurrentForGuild(guildId);
  if (!draft) throw new DraftError('NO_DRAFT', 'There is no draft in this server yet. An admin can create one with `/draft setup`.');
  return draft;
}

export function requireActiveDraft(ctx: BotContext, guildId: string): Draft {
  const draft = requireOpenDraft(ctx, guildId);
  if (draft.status !== 'active') {
    throw new DraftError('INVALID_STATE', draft.status === 'setup' || draft.status === 'randomized' ? 'The draft has not started yet.' : 'The draft is not active.');
  }
  return draft;
}

/**
 * Resolves which seat a user is acting for. With one seat it is implicit; with several
 * the `seat` option (participant id or label) must be given.
 */
export function resolveUserSeat(ctx: BotContext, draft: Draft, userId: string, seatOption: string | null): ParticipantWithUsers {
  const repo = ctx.service.repos.participants;
  const seats = repo.listSeatsForUser(draft.id, userId);
  if (seats.length === 0) throw new DraftError('NOT_PARTICIPANT', 'You are not registered as a participant in this draft. Ask an admin to add you with `/draft participant add`.');
  if (seatOption) {
    const seat = resolveParticipantRef(ctx, draft, seatOption);
    if (!seats.some((s) => s.id === seat.id)) throw new DraftError('PERMISSION_DENIED', `You are not a member of "${seat.label}".`);
    return seat;
  }
  if (seats.length > 1) {
    throw new DraftError('VALIDATION', `You control several seats (${seats.map((s) => s.label).join(', ')}). Add the \`seat\` option to say which one you mean.`);
  }
  return repo.getWithUsers(seats[0]!.id) as ParticipantWithUsers;
}

/**
 * Resolves a participant reference typed or autocompleted by a user: a participant id
 * ("id:12"), a user mention / id, or a seat label.
 */
export function resolveParticipantRef(ctx: BotContext, draft: Draft, ref: string): ParticipantWithUsers {
  const repo = ctx.service.repos.participants;
  const text = ref.trim();
  let m: RegExpExecArray | null;
  if ((m = /^id:(\d+)$/.exec(text))) {
    const p = repo.getWithUsers(Number(m[1]));
    if (p && p.draftId === draft.id) return p;
  }
  if ((m = /^<@!?(\d+)>$/.exec(text)) || (m = /^(\d{15,22})$/.exec(text))) {
    const seats = repo.listSeatsForUser(draft.id, m[1] as string);
    if (seats.length === 1) return repo.getWithUsers(seats[0]!.id) as ParticipantWithUsers;
    if (seats.length > 1) throw new DraftError('VALIDATION', `That user controls several seats (${seats.map((s) => s.label).join(', ')}). Pick the seat by label instead.`);
    throw new DraftError('PARTICIPANT_NOT_FOUND', 'That user is not a participant in this draft.');
  }
  const byLabel = repo.getByLabel(draft.id, text);
  if (byLabel) return repo.getWithUsers(byLabel.id) as ParticipantWithUsers;
  throw new DraftError('PARTICIPANT_NOT_FOUND', `No participant matches "${text}". Use the autocomplete suggestions.`);
}

export function participantChoices(ctx: BotContext, draft: Draft, query: string): Array<{ name: string; value: string }> {
  const q = query.toLowerCase();
  return ctx.service.repos.participants
    .listWithUsers(draft.id)
    .filter((p) => !q || p.label.toLowerCase().includes(q) || p.users.some((u) => u.discordUserId.includes(q)))
    .slice(0, 25)
    .map((p) => ({ name: `${p.draftPosition ? `#${p.draftPosition} ` : ''}${p.label}`.slice(0, 100), value: `id:${p.id}` }));
}

export function teamChoices(ctx: BotContext, draft: Draft, query: string, mode: 'available' | 'all' | 'removed'): Array<{ name: string; value: string }> {
  const repos = ctx.service.repos;
  const config = repos.drafts.getConfig(draft.id);
  let teams;
  if (mode === 'available') teams = repos.teams.listAvailable(draft.id, config.maxInstancesPerTeam, query, 25);
  else if (mode === 'removed') teams = repos.teams.listByDraft(draft.id, { includeRemoved: true }).filter((t) => t.removedAt && t.teamNumber.includes(query.toUpperCase())).slice(0, 25);
  else teams = repos.teams.search(draft.id, query, 25);
  return teams.map((t) => ({ name: `${t.teamNumber}${t.teamName ? ` — ${t.teamName}` : ''}`.slice(0, 100), value: t.teamNumber }));
}

export function rosterTeamChoices(ctx: BotContext, draft: Draft, participantId: number, query: string): Array<{ name: string; value: string }> {
  const repos = ctx.service.repos;
  const q = query.toUpperCase();
  return repos.assets
    .listRoster(participantId)
    .map((a) => repos.teams.getById(a.teamId as number))
    .filter((t): t is NonNullable<typeof t> => !!t && (!q || t.teamNumber.includes(q) || (t.teamName ?? '').toUpperCase().includes(q)))
    .slice(0, 25)
    .map((t) => ({ name: `${t.teamNumber}${t.teamName ? ` — ${t.teamName}` : ''}`.slice(0, 100), value: t.teamNumber }));
}

export async function respondAutocomplete(interaction: AutocompleteInteraction<'cached'>, choices: Array<{ name: string; value: string }>): Promise<void> {
  try {
    await interaction.respond(choices.slice(0, 25));
  } catch {
    /* interaction expired; ignore */
  }
}
