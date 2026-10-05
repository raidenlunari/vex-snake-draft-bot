import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import { formatDuration, parseDuration, parseHHMM } from '../../domain/config.js';
import { DraftError } from '../../domain/errors.js';
import type { DraftConfig, Team } from '../../domain/types.js';
import { normalizeTeamNumber } from '../../engine/draftEngine.js';
import { Colors } from '../../services/announcer.js';
import { customId, type BotContext, type Command } from '../context.js';
import {
  participantChoices,
  requireAdmin,
  requireCurrentDraft,
  requireOpenDraft,
  resolveParticipantRef,
  respondAutocomplete,
  rosterTeamChoices,
  teamChoices,
} from '../permissions.js';
import { defer, send, sendText } from '../respond.js';
import { auditEmbed, configEmbed, importSummaryEmbed, orderEmbed, participantsEmbed, repickEmbed, seatName, teamEmbed, tradeEmbed, tradeButtons, tradeMentions } from '../views/index.js';
import { fetchAttachmentText } from '../util/attachments.js';
import { describeResolution } from './trade.js';
import { parseSpreadsheetId } from '../../integrations/googleSheets.js';
import { describeSheet } from '../../services/sheetSync.js';

const onOff = (b: boolean): string => (b ? 'enabled' : 'disabled');

const data = new SlashCommandBuilder()
  .setName('draft')
  .setDescription('Admin commands for running the VEX snake draft')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('setup').setDescription('Create a new draft').addStringOption((o) => o.setName('name').setDescription('Draft name').setMaxLength(80)))
  .addSubcommand((s) =>
    s
      .setName('import')
      .setDescription('Import VEX teams from a CSV file')
      .addAttachmentOption((o) => o.setName('file').setDescription('CSV with team number, name, organization, location').setRequired(true))
      .addStringOption((o) => o.setName('mode').setDescription('How to treat teams already in the draft').addChoices({ name: 'merge (update details)', value: 'merge' }, { name: 'skip existing', value: 'skip-existing' })),
  )
  .addSubcommand((s) => s.setName('randomize').setDescription('Randomize the draft order'))
  .addSubcommand((s) => s.setName('start').setDescription('Start the draft').addBooleanOption((o) => o.setName('confirm').setDescription('Skip the confirmation step')))
  .addSubcommand((s) => s.setName('skip').setDescription('Skip the player currently on the clock'))
  .addSubcommand((s) => s.setName('complete').setDescription('End the draft now, forfeiting remaining picks'))
  .addSubcommand((s) => s.setName('reset').setDescription('Wipe the current draft').addBooleanOption((o) => o.setName('purge').setDescription('Delete all draft data instead of archiving it')))
  .addSubcommand((s) => s.setName('audit').setDescription('Show recent audit events').addIntegerOption((o) => o.setName('limit').setDescription('How many (default 15)').setMinValue(1).setMaxValue(40)))
  .addSubcommandGroup((g) =>
    g
      .setName('channel')
      .setDescription('Where the draft is announced')
      .addSubcommand((s) =>
        s
          .setName('set')
          .setDescription('Use a channel, thread or forum post (default: here)')
          .addChannelOption((o) => o.setName('channel').setDescription('Text channel, thread, forum post or forum').addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildForum, ChannelType.GuildAnnouncement, ChannelType.AnnouncementThread))
          .addStringOption((o) => o.setName('post-title').setDescription('When a forum is chosen: title of the new post to create').setMaxLength(100)),
      )
      .addSubcommand((s) => s.setName('view').setDescription('Show the configured draft channel')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('sheet')
      .setDescription('Mirror the draft to a Google Sheet')
      .addSubcommand((s) =>
        s
          .setName('set')
          .setDescription('Link a Google Sheet (share it with the bot service account first)')
          .addStringOption((o) => o.setName('url').setDescription('Spreadsheet URL or id').setRequired(true))
          .addStringOption((o) => o.setName('tab').setDescription('Tab name to write (default: Draft)').setMaxLength(60)),
      )
      .addSubcommand((s) => s.setName('sync').setDescription('Write the current draft state to the sheet now'))
      .addSubcommand((s) => s.setName('view').setDescription('Show the linked sheet'))
      .addSubcommand((s) => s.setName('clear').setDescription('Stop mirroring to the sheet')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('participant')
      .setDescription('Manage draft participants')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a participant; list several users to register them as one team')
          .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(true))
          .addUserOption((o) => o.setName('user2').setDescription('Second team member'))
          .addUserOption((o) => o.setName('user3').setDescription('Third team member'))
          .addUserOption((o) => o.setName('user4').setDescription('Fourth team member'))
          .addUserOption((o) => o.setName('user5').setDescription('Fifth team member'))
          .addStringOption((o) => o.setName('label').setDescription('Seat/team label (default: display name)').setMaxLength(60))
          .addStringOption((o) => o.setName('seat').setDescription('Add the user(s) to this existing seat instead').setAutocomplete(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a seat, or a user from a seat')
          .addStringOption((o) => o.setName('seat').setDescription('Seat').setRequired(true).setAutocomplete(true))
          .addUserOption((o) => o.setName('user').setDescription('Only remove this user from the seat')),
      )
      .addSubcommand((s) => s.setName('list').setDescription('List participants')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('config')
      .setDescription('View or change draft settings')
      .addSubcommand((s) => s.setName('view').setDescription('Show the current configuration'))
      .addSubcommand((s) => s.setName('name').setDescription('Rename the draft').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(80)))
      .addSubcommand((s) => s.setName('rounds').setDescription('Number of rounds').addIntegerOption((o) => o.setName('number').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)))
      .addSubcommand((s) => s.setName('picks-per-round').setDescription('Picks each participant makes per turn').addIntegerOption((o) => o.setName('number').setDescription('1-10').setRequired(true).setMinValue(1).setMaxValue(10)))
      .addSubcommand((s) => s.setName('participants').setDescription('Expected number of participants (0 = as registered)').addIntegerOption((o) => o.setName('number').setDescription('0 or more').setRequired(true).setMinValue(0)))
      .addSubcommand((s) => s.setName('snake').setDescription('Snake order on/off').addBooleanOption((o) => o.setName('enabled').setDescription('Reverse order every other round').setRequired(true)))
      .addSubcommand((s) => s.setName('skip-time').setDescription('Auto-skip timer duration').addStringOption((o) => o.setName('duration').setDescription('e.g. 15m, 1h30m, or 0 to disable').setRequired(true)))
      .addSubcommand((s) =>
        s
          .setName('skip-hours')
          .setDescription('Hours during which the timer counts down')
          .addStringOption((o) => o.setName('start').setDescription('HH:MM, or "always"').setRequired(true))
          .addStringOption((o) => o.setName('end').setDescription('HH:MM')),
      )
      .addSubcommand((s) => s.setName('timezone').setDescription('Time zone for skip hours').addStringOption((o) => o.setName('zone').setDescription('IANA zone, e.g. America/Chicago').setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) =>
        s
          .setName('prepicks')
          .setDescription('Prepicks on/off and when they apply')
          .addBooleanOption((o) => o.setName('enabled').setDescription('Allow prepicks').setRequired(true))
          .addStringOption((o) => o.setName('mode').setDescription('When to apply them').addChoices({ name: 'immediately when the turn starts', value: 'immediate' }, { name: 'only when the timer runs out', value: 'on_timeout' })),
      )
      .addSubcommand((s) => s.setName('after-skip').setDescription('What happens to a skipped pick').addStringOption((o) => o.setName('policy').setDescription('Policy').setRequired(true).addChoices({ name: 'player may pick later (catch up)', value: 'catch_up' }, { name: 'pick is forfeited', value: 'forfeit' })))
      .addSubcommand((s) => s.setName('trades').setDescription('Trades on/off').addBooleanOption((o) => o.setName('enabled').setDescription('Allow trades').setRequired(true)))
      .addSubcommand((s) => s.setName('two-for-one').setDescription('Uneven (2-for-1) trades on/off').addBooleanOption((o) => o.setName('enabled').setDescription('Allow').setRequired(true)))
      .addSubcommand((s) => s.setName('future-picks').setDescription('Trading future draft picks on/off').addBooleanOption((o) => o.setName('enabled').setDescription('Allow').setRequired(true)))
      .addSubcommand((s) => s.setName('trade-approval').setDescription('How trades get executed').addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices({ name: 'counterparty accepts', value: 'counterparty' }, { name: 'counterparty accepts, then admin approves', value: 'admin' }, { name: 'execute immediately (no approval)', value: 'auto' })))
      .addSubcommand((s) => s.setName('post-draft-trades').setDescription('Allow trades after the draft completes').addBooleanOption((o) => o.setName('enabled').setDescription('Allow').setRequired(true)))
      .addSubcommand((s) => s.setName('team-instances').setDescription('How many copies of a team can be drafted').addIntegerOption((o) => o.setName('number').setDescription('1 = unique teams').setRequired(true).setMinValue(1).setMaxValue(50)))
      .addSubcommand((s) => s.setName('seats-per-user').setDescription('How many seats one Discord user may control').addIntegerOption((o) => o.setName('number').setDescription('1 or more').setRequired(true).setMinValue(1).setMaxValue(50)))
      .addSubcommand((s) => s.setName('roster-size').setDescription('Max teams + remaining picks per seat (0 = unlimited)').addIntegerOption((o) => o.setName('number').setDescription('0 = unlimited').setRequired(true).setMinValue(0)))
      .addSubcommand((s) => s.setName('pick-confirmation').setDescription('Ask players to confirm /pick with a button').addBooleanOption((o) => o.setName('enabled').setDescription('Require confirmation').setRequired(true)))
      .addSubcommand((s) => s.setName('admin-role').setDescription('Role that may run /draft commands (besides Manage Server)').addRoleOption((o) => o.setName('role').setDescription('Role (omit to clear)'))),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('roster')
      .setDescription('Edit rosters during a live draft')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a team to a roster outside the pick order')
          .addStringOption((o) => o.setName('participant').setDescription('Seat').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('replace')
          .setDescription('Swap a rostered team for another, keeping its pick number')
          .addStringOption((o) => o.setName('participant').setDescription('Seat').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('old-team').setDescription('Team currently on the roster').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('new-team').setDescription('Replacement team').setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('drop')
          .setDescription('Drop a team from a roster')
          .addStringOption((o) => o.setName('participant').setDescription('Seat').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true))
          .addBooleanOption((o) => o.setName('remove-from-pool').setDescription('Also remove the team from the draft (default: return to pool)')),
      )
      .addSubcommand((s) =>
        s
          .setName('move')
          .setDescription('Move a team from one roster to another')
          .addStringOption((o) => o.setName('from').setDescription('Seat giving the team').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('to').setDescription('Seat receiving the team').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true)),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('team')
      .setDescription('Manage the team pool')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a single team')
          .addStringOption((o) => o.setName('number').setDescription('Team number, e.g. 1234A').setRequired(true).setMaxLength(8))
          .addStringOption((o) => o.setName('name').setDescription('Team name').setMaxLength(100))
          .addStringOption((o) => o.setName('organization').setDescription('School / organization').setMaxLength(100))
          .addStringOption((o) => o.setName('location').setDescription('City, region').setMaxLength(100)),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a team from the draft entirely')
          .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true))
          .addBooleanOption((o) => o.setName('force').setDescription('Also drop it from any roster it is on')),
      )
      .addSubcommand((s) => s.setName('restore').setDescription('Return a removed team to the pool').addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('list').setDescription('List teams in the pool').addStringOption((o) => o.setName('filter').setDescription('Only show matching numbers/names')).addBooleanOption((o) => o.setName('available-only').setDescription('Hide drafted teams'))),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('pick')
      .setDescription('Admin pick controls')
      .addSubcommand((s) =>
        s
          .setName('force')
          .setDescription('Make a pick on behalf of a participant')
          .addStringOption((o) => o.setName('team').setDescription('Team number').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('participant').setDescription('Seat (default: whoever is on the clock)').setAutocomplete(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('correct')
          .setDescription('Change the team selected at a given overall pick number')
          .addIntegerOption((o) => o.setName('pick').setDescription('Overall pick number').setRequired(true).setMinValue(1))
          .addStringOption((o) => o.setName('team').setDescription('Correct team').setRequired(true).setAutocomplete(true)),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('repick')
      .setDescription('Replace a team that no-showed (drafter chooses, admin approves)')
      .addSubcommand((s) =>
        s
          .setName('start')
          .setDescription('Open a repick: removes the team and lets the drafter choose a replacement')
          .addStringOption((o) => o.setName('participant').setDescription('Seat holding the team').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('team').setDescription('Team that is out').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('reason').setDescription('e.g. no-show').setMaxLength(200)),
      )
      .addSubcommand((s) => s.setName('approve').setDescription('Approve the chosen replacement').addIntegerOption((o) => o.setName('id').setDescription('Repick id').setRequired(true)).addStringOption((o) => o.setName('note').setDescription('Note').setMaxLength(200)))
      .addSubcommand((s) => s.setName('deny').setDescription('Deny the chosen replacement; the drafter picks again').addIntegerOption((o) => o.setName('id').setDescription('Repick id').setRequired(true)).addStringOption((o) => o.setName('note').setDescription('Why').setMaxLength(200)))
      .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a repick').addIntegerOption((o) => o.setName('id').setDescription('Repick id').setRequired(true)).addBooleanOption((o) => o.setName('restore').setDescription('Put the original team back (default: yes)')))
      .addSubcommand((s) => s.setName('list').setDescription('List open repicks')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('trade')
      .setDescription('Admin trade controls')
      .addSubcommand((s) => s.setName('approve').setDescription('Approve an accepted trade').addIntegerOption((o) => o.setName('id').setDescription('Trade id').setRequired(true)))
      .addSubcommand((s) => s.setName('deny').setDescription('Deny a pending trade').addIntegerOption((o) => o.setName('id').setDescription('Trade id').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('List pending trades')),
  );

function teamOrThrow(ctx: BotContext, draftId: number, raw: string): Team {
  const team = ctx.service.repos.teams.getByNumber(draftId, normalizeTeamNumber(raw));
  if (!team) throw new DraftError('TEAM_NOT_FOUND', `Team ${normalizeTeamNumber(raw)} is not in this draft.`);
  return team;
}

async function execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const actor = requireAdmin(interaction, ctx);
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const { service } = ctx;
  const repos = service.repos;

  if (!group) {
    switch (sub) {
      case 'setup': {
        const name = interaction.options.getString('name') ?? `${interaction.guild.name} Draft`;
        const draft = service.engine.createDraft({ guildId, name, actor, timezone: ctx.env.DEFAULT_TIMEZONE });
        await send(interaction, {
          embeds: [
            {
              title: `Draft "${draft.name}" created`,
              color: Colors.success,
              description: [
                'Next steps:',
                '1. `/draft channel set` — choose where the draft runs (channel, thread or forum post).',
                '2. `/draft import` — upload the team list CSV (or `/draft team add`).',
                '3. `/draft participant add` — register each player.',
                '4. `/draft config …` — rounds, timers, trades; `/draft config view` to review.',
                '5. `/draft randomize` then `/draft start`.',
              ].join('\n'),
            },
          ],
        });
        return;
      }
      case 'import': {
        const draft = requireOpenDraft(ctx, guildId);
        const file = interaction.options.getAttachment('file', true);
        const mode = (interaction.options.getString('mode') ?? 'merge') as 'merge' | 'skip-existing';
        await defer(interaction);
        const text = await fetchAttachmentText(file);
        const summary = await service.importTeams(draft.id, text, actor, mode);
        await send(interaction, { embeds: [importSummaryEmbed(summary)] });
        return;
      }
      case 'randomize': {
        const draft = requireOpenDraft(ctx, guildId);
        const order = service.engine.randomize(draft.id, actor);
        const validation = service.engine.validateReadyToStart(draft.id);
        await send(interaction, {
          content: '🎲 Draft order randomized. Review it, then press **Start draft** (or run `/draft start`).',
          embeds: [orderEmbed(draft, order, validation)],
          buttons: [
            { id: customId('start', 'confirm', draft.id), label: 'Start draft', style: 'success', emoji: '🏁' },
            { id: customId('start', 'randomize', draft.id), label: 'Re-randomize', style: 'secondary', emoji: '🎲' },
          ],
        });
        return;
      }
      case 'start': {
        const draft = requireOpenDraft(ctx, guildId);
        const validation = service.engine.validateReadyToStart(draft.id);
        const participants = repos.participants.listWithUsers(draft.id);
        if (validation.errors.length > 0) {
          await send(interaction, { content: '❌ The draft cannot start yet.', embeds: [orderEmbed(draft, participants, validation)] }, { ephemeral: true });
          return;
        }
        if (interaction.options.getBoolean('confirm')) {
          await defer(interaction);
          await service.start(draft.id, actor);
          await sendText(interaction, `🏁 Draft started. Announcements are in <#${draft.channelId}>.`);
          return;
        }
        await send(interaction, {
          content: 'Ready to start? This locks rounds, picks per round, snake order and participants.',
          embeds: [orderEmbed(draft, participants, validation)],
          buttons: [
            { id: customId('start', 'confirm', draft.id), label: 'Start draft', style: 'success', emoji: '🏁' },
            { id: customId('start', 'cancel', draft.id), label: 'Not yet', style: 'secondary' },
          ],
        });
        return;
      }
      case 'skip': {
        const draft = requireOpenDraft(ctx, guildId);
        await defer(interaction);
        const events = await service.skip(draft.id, actor);
        const skipped = events.find((e) => e.type === 'turn_skipped');
        await sendText(interaction, skipped && skipped.type === 'turn_skipped' ? `⏭️ Skipped ${seatName(skipped.participant)} (pick #${skipped.slot.overallPick}).` : '⏭️ Skipped.');
        return;
      }
      case 'complete': {
        const draft = requireOpenDraft(ctx, guildId);
        await send(interaction, {
          content: '⚠️ End the draft now? Remaining picks will be forfeited. This cannot be undone.',
          buttons: [
            { id: customId('complete', 'confirm', draft.id), label: 'End the draft', style: 'danger' },
            { id: customId('complete', 'cancel', draft.id), label: 'Cancel', style: 'secondary' },
          ],
        }, { ephemeral: true });
        return;
      }
      case 'reset': {
        const draft = requireCurrentDraft(ctx, guildId);
        const purge = interaction.options.getBoolean('purge') ?? false;
        await send(interaction, {
          content: `⚠️ **Reset draft "${draft.name}"?** ${purge ? 'All picks, rosters, teams and participants will be permanently deleted (audit events are kept).' : 'The draft will be archived; its history stays in the database.'} You can immediately set up a new draft afterwards.`,
          buttons: [
            { id: customId('reset', 'confirm', draft.id, purge ? 1 : 0), label: purge ? 'Reset and purge' : 'Reset (archive)', style: 'danger', emoji: '🗑️' },
            { id: customId('reset', 'cancel', draft.id), label: 'Cancel', style: 'secondary' },
          ],
        }, { ephemeral: true });
        return;
      }
      case 'audit': {
        const draft = requireCurrentDraft(ctx, guildId);
        const limit = interaction.options.getInteger('limit') ?? 15;
        await send(interaction, { embeds: [auditEmbed(draft, repos.audit.listForDraft(draft.id, limit))] }, { ephemeral: true });
        return;
      }
      default:
        throw new DraftError('VALIDATION', 'Unknown subcommand.');
    }
  }

  if (group === 'channel') {
    const draft = requireOpenDraft(ctx, guildId);
    if (sub === 'view') {
      await sendText(interaction, draft.channelId ? `📣 Draft announcements go to <#${draft.channelId}> (${draft.channelKind}).` : '📣 No draft channel is set. Use `/draft channel set`.', { ephemeral: true });
      return;
    }
    const chosen = interaction.options.getChannel('channel') ?? interaction.channel;
    if (!chosen || !('type' in chosen)) throw new DraftError('VALIDATION', 'Pick a channel, thread or forum post.');
    await defer(interaction);
    let target = chosen as GuildTextBasedChannel | { type: ChannelType; id: string; name: string };
    if (target.type === ChannelType.GuildForum || target.type === ChannelType.GuildMedia) {
      const forum = await interaction.guild.channels.fetch(target.id);
      if (!forum || forum.type !== ChannelType.GuildForum) throw new DraftError('VALIDATION', 'That forum could not be loaded.');
      const title = interaction.options.getString('post-title') ?? draft.name;
      const post = await forum.threads.create({
        name: title.slice(0, 100),
        autoArchiveDuration: 10080,
        message: { content: `📋 **${draft.name}** — this post hosts the draft. Use \`/status\` any time to see where things stand.` },
        reason: `Draft channel for ${draft.name}`,
      });
      await service.setChannel(draft.id, { channelId: post.id, kind: 'forum_post', parentChannelId: forum.id }, actor);
      await sendText(interaction, `📣 Created forum post <#${post.id}> and set it as the draft channel.`);
      return;
    }
    const fetched = await interaction.guild.channels.fetch(target.id);
    if (!fetched || !fetched.isTextBased()) throw new DraftError('VALIDATION', 'The bot cannot send messages in that channel.');
    const me = await interaction.guild.members.fetchMe();
    const perms = fetched.permissionsFor(me);
    const needed = fetched.isThread() ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.EmbedLinks] : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!perms || !perms.has(needed)) {
      throw new DraftError('VALIDATION', 'The bot needs View Channel, Send Messages (in threads) and Embed Links in that channel.');
    }
    const kind = fetched.isThread() ? (fetched.parent?.type === ChannelType.GuildForum || fetched.parent?.type === ChannelType.GuildMedia ? 'forum_post' : 'thread') : 'text';
    target = fetched;
    await service.setChannel(draft.id, { channelId: fetched.id, kind, parentChannelId: fetched.isThread() ? (fetched.parentId ?? null) : null }, actor);
    await sendText(interaction, `📣 Draft announcements will go to <#${fetched.id}>${kind === 'forum_post' ? ' (forum post)' : kind === 'thread' ? ' (thread)' : ''}.`);
    return;
  }

  if (group === 'sheet') {
    const draft = requireCurrentDraft(ctx, guildId);
    const sheets = service.sheets;
    if (sub === 'view') {
      const err = sheets?.lastError.get(draft.id);
      await sendText(interaction, `📊 Sheet: ${describeSheet(draft)}${sheets?.enabled ? '' : '\n⚠️ The bot has no Google service account configured (GOOGLE_SERVICE_ACCOUNT_FILE), so nothing is written.'}${err ? `\n⚠️ Last sync error: ${err}` : ''}`, { ephemeral: true });
      return;
    }
    if (sub === 'clear') {
      service.engine.setSheet(draft.id, null, actor);
      await sendText(interaction, '✅ Google Sheet mirroring turned off.');
      return;
    }
    if (!sheets?.enabled || !sheets.client) {
      throw new DraftError('VALIDATION', 'Google Sheets sync is not configured on this bot. Set GOOGLE_SERVICE_ACCOUNT_FILE in the bot’s .env (see docs/SETUP.md).');
    }
    await defer(interaction);
    if (sub === 'set') {
      const spreadsheetId = parseSpreadsheetId(interaction.options.getString('url', true));
      if (!spreadsheetId) throw new DraftError('VALIDATION', 'That does not look like a Google Sheets URL or id.');
      const tab = (interaction.options.getString('tab') ?? 'Draft').trim() || 'Draft';
      let title: string;
      try {
        title = (await sheets.client.describe(spreadsheetId)).title;
      } catch (err) {
        throw new DraftError('VALIDATION', `The bot cannot open that spreadsheet (${err instanceof Error ? err.message : String(err)}). Share it with **${sheets.client.serviceAccountEmail}** as an editor and try again.`);
      }
      service.engine.setSheet(draft.id, { spreadsheetId, tab }, actor);
      await sheets.syncNow(draft.id);
      await sendText(interaction, `✅ Mirroring to **${title}** → tab **${tab}**. The sheet updates after every pick, skip, trade and admin change.\n${describeSheet(service.repos.drafts.getById(draft.id)!)}`);
      return;
    }
    if (sub === 'sync') {
      if (!draft.sheetSpreadsheetId) throw new DraftError('VALIDATION', 'No sheet is linked yet. Use `/draft sheet set` first.');
      await sheets.syncNow(draft.id);
      await sendText(interaction, `✅ Sheet updated: ${describeSheet(draft)}`);
      return;
    }
  }

  if (group === 'participant') {
    const draft = requireOpenDraft(ctx, guildId);
    if (sub === 'list') {
      await send(interaction, { embeds: [participantsEmbed(draft, repos.participants.listWithUsers(draft.id))] });
      return;
    }
    if (sub === 'add') {
      const users = [...new Map(['user', 'user2', 'user3', 'user4', 'user5'].map((n) => interaction.options.getUser(n)).filter((u): u is NonNullable<typeof u> => !!u).map((u) => [u.id, u])).values()];
      const seatRef = interaction.options.getString('seat');
      await defer(interaction);
      if (seatRef) {
        const seat = resolveParticipantRef(ctx, draft, seatRef);
        let updated = seat;
        for (const u of users) updated = service.engine.addUserToSeat(draft.id, seat.id, u.id, actor);
        await sendText(interaction, `✅ Added ${users.map((u) => `<@${u.id}>`).join(', ')} to **${updated.label}** (${updated.users.length} member(s)).`);
        return;
      }
      const members = await Promise.all(users.map((u) => interaction.guild.members.fetch(u.id).catch(() => null)));
      const names = users.map((u, i) => members[i]?.displayName ?? u.username);
      const requested = interaction.options.getString('label');
      let label = requested ?? (users.length > 1 ? names.join(' & ').slice(0, 60) : names[0]!);
      if (!requested) {
        // Auto-suffix display-name collisions so two "Alex"es can both join.
        let n = 2;
        const base = label.slice(0, 55);
        while (repos.participants.getByLabel(draft.id, label)) label = `${base} (${n++})`;
      }
      const created = service.engine.addParticipant(draft.id, { label, discordUserIds: users.map((u) => u.id), actor });
      const count = repos.participants.listByDraft(draft.id).length;
      const kind = users.length > 1 ? 'team' : 'participant';
      await sendText(
        interaction,
        `✅ Added ${kind} **${created.label}** (${users.map((u) => `<@${u.id}>`).join(', ')}). ${count} seat(s) registered.${draft.status === 'randomized' ? ' The order was cleared; run `/draft randomize` again.' : ''}`,
      );
      return;
    }
    if (sub === 'remove') {
      const seat = resolveParticipantRef(ctx, draft, interaction.options.getString('seat', true));
      const target = interaction.options.getUser('user');
      if (target) {
        const updated = service.engine.removeUserFromSeat(draft.id, seat.id, target.id, actor);
        await sendText(interaction, `✅ Removed <@${target.id}> from seat **${updated.label}**.`);
        return;
      }
      service.engine.removeParticipant(draft.id, seat.id, actor);
      await sendText(interaction, `✅ Removed seat **${seat.label}**.${draft.status === 'randomized' ? ' The order was cleared; run `/draft randomize` again.' : ''}`);
      return;
    }
  }

  if (group === 'config') {
    if (sub === 'admin-role') {
      const role = interaction.options.getRole('role');
      service.engine.setAdminRole(guildId, role?.id ?? null, actor);
      await sendText(interaction, role ? `✅ Members with <@&${role.id}> can now run \`/draft\` commands.` : '✅ Admin role cleared; only Manage Server / Administrator can run `/draft` commands.');
      return;
    }
    const draft = requireOpenDraft(ctx, guildId);
    if (sub === 'view') {
      const settings = repos.drafts.getGuildSettings(guildId);
      await send(interaction, { embeds: [configEmbed(draft, repos.drafts.getConfig(draft.id), repos.participants.listWithUsers(draft.id), repos.teams.count(draft.id), settings?.adminRoleId ?? null)] });
      return;
    }
    if (sub === 'name') {
      const renamed = service.engine.renameDraft(draft.id, interaction.options.getString('name', true), actor);
      await sendText(interaction, `✅ Draft renamed to **${renamed.name}**.`);
      return;
    }
    const patch: Partial<DraftConfig> = {};
    let note = '';
    switch (sub) {
      case 'rounds':
        patch.rounds = interaction.options.getInteger('number', true);
        note = `Rounds set to ${patch.rounds}.`;
        break;
      case 'picks-per-round':
        patch.picksPerRound = interaction.options.getInteger('number', true);
        note = `Picks per round set to ${patch.picksPerRound}.`;
        break;
      case 'participants': {
        const n = interaction.options.getInteger('number', true);
        patch.participantCount = n === 0 ? null : n;
        note = n === 0 ? 'Participant count will follow the registered seats.' : `Expecting ${n} participants.`;
        break;
      }
      case 'snake':
        patch.snakeOrder = interaction.options.getBoolean('enabled', true);
        note = `Snake order ${onOff(patch.snakeOrder)}.`;
        break;
      case 'skip-time': {
        const seconds = parseDuration(interaction.options.getString('duration', true));
        patch.skipTimerSeconds = seconds > 0 ? seconds : null;
        note = seconds > 0 ? `Skip timer set to ${formatDuration(seconds)}.` : 'Automatic skipping disabled.';
        break;
      }
      case 'skip-hours': {
        const start = interaction.options.getString('start', true).trim();
        const end = interaction.options.getString('end');
        if (/^(always|clear|none|off)$/i.test(start)) {
          patch.skipHoursStart = null;
          patch.skipHoursEnd = null;
          note = 'The skip timer now runs around the clock.';
        } else {
          if (!end) throw new DraftError('VALIDATION', 'Give both a start and an end time (HH:MM), or "always".');
          parseHHMM(start);
          parseHHMM(end);
          patch.skipHoursStart = start;
          patch.skipHoursEnd = end;
          note = `Skip timer active ${start}–${end}.`;
        }
        break;
      }
      case 'timezone':
        patch.timezone = interaction.options.getString('zone', true).trim();
        note = `Time zone set to ${patch.timezone}.`;
        break;
      case 'prepicks':
        patch.allowPrepicks = interaction.options.getBoolean('enabled', true);
        {
          const mode = interaction.options.getString('mode');
          if (mode) patch.prepickMode = mode as DraftConfig['prepickMode'];
        }
        note = `Prepicks ${onOff(patch.allowPrepicks)}${patch.prepickMode ? ` (${patch.prepickMode === 'immediate' ? 'applied immediately' : 'applied on timeout'})` : ''}.`;
        break;
      case 'after-skip':
        patch.afterSkipPolicy = interaction.options.getString('policy', true) as DraftConfig['afterSkipPolicy'];
        note = patch.afterSkipPolicy === 'catch_up' ? 'Skipped players may pick later.' : 'Skipped picks are forfeited.';
        break;
      case 'trades':
        patch.allowTrades = interaction.options.getBoolean('enabled', true);
        if (!patch.allowTrades) {
          patch.allowTwoForOne = false;
          patch.allowFuturePickTrades = false;
        }
        note = `Trades ${onOff(patch.allowTrades)}.`;
        break;
      case 'two-for-one':
        patch.allowTwoForOne = interaction.options.getBoolean('enabled', true);
        note = `2-for-1 trades ${onOff(patch.allowTwoForOne)}.`;
        break;
      case 'future-picks':
        patch.allowFuturePickTrades = interaction.options.getBoolean('enabled', true);
        note = `Future-pick trades ${onOff(patch.allowFuturePickTrades)}.`;
        break;
      case 'trade-approval':
        patch.tradeApproval = interaction.options.getString('mode', true) as DraftConfig['tradeApproval'];
        note = `Trade approval mode: ${patch.tradeApproval}.`;
        break;
      case 'post-draft-trades':
        patch.allowTradesAfterCompletion = interaction.options.getBoolean('enabled', true);
        note = `Trades after completion ${onOff(patch.allowTradesAfterCompletion)}.`;
        break;
      case 'team-instances':
        patch.maxInstancesPerTeam = interaction.options.getInteger('number', true);
        note = `Each team can be drafted ${patch.maxInstancesPerTeam} time(s).`;
        break;
      case 'seats-per-user':
        patch.maxSeatsPerUser = interaction.options.getInteger('number', true);
        note = `One user may control up to ${patch.maxSeatsPerUser} seat(s).`;
        break;
      case 'roster-size': {
        const n = interaction.options.getInteger('number', true);
        patch.maxRosterSize = n === 0 ? null : n;
        note = n === 0 ? 'Roster size is unlimited.' : `Max roster size set to ${n}.`;
        break;
      }
      case 'pick-confirmation':
        patch.requirePickConfirmation = interaction.options.getBoolean('enabled', true);
        note = `Pick confirmation ${onOff(patch.requirePickConfirmation)}.`;
        break;
      default:
        throw new DraftError('VALIDATION', 'Unknown setting.');
    }
    await service.updateConfig(draft.id, patch, actor);
    await sendText(interaction, `✅ ${note}`);
    return;
  }

  if (group === 'roster') {
    const draft = requireCurrentDraft(ctx, guildId);
    await defer(interaction);
    if (sub === 'add') {
      const p = resolveParticipantRef(ctx, draft, interaction.options.getString('participant', true));
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      await service.adminAddTeam(draft.id, p.id, team.id, actor);
      await sendText(interaction, `✅ Added **${team.teamNumber}** to ${seatName(p)}.`);
      return;
    }
    if (sub === 'replace') {
      const p = resolveParticipantRef(ctx, draft, interaction.options.getString('participant', true));
      const oldTeam = teamOrThrow(ctx, draft.id, interaction.options.getString('old-team', true));
      const newTeam = teamOrThrow(ctx, draft.id, interaction.options.getString('new-team', true));
      await service.adminReplaceTeam(draft.id, { participantId: p.id, oldTeamId: oldTeam.id }, newTeam.id, actor);
      await sendText(interaction, `✅ Replaced **${oldTeam.teamNumber}** with **${newTeam.teamNumber}** on ${seatName(p)}.`);
      return;
    }
    if (sub === 'drop') {
      const p = resolveParticipantRef(ctx, draft, interaction.options.getString('participant', true));
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      const removeFromPool = interaction.options.getBoolean('remove-from-pool') ?? false;
      await service.adminDropTeam(draft.id, p.id, team.id, removeFromPool, actor);
      await sendText(interaction, `✅ Dropped **${team.teamNumber}** from ${seatName(p)}${removeFromPool ? ' and removed it from the pool' : '; it is available again'}.`);
      return;
    }
    if (sub === 'move') {
      const from = resolveParticipantRef(ctx, draft, interaction.options.getString('from', true));
      const to = resolveParticipantRef(ctx, draft, interaction.options.getString('to', true));
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      await service.adminMoveTeam(draft.id, from.id, to.id, team.id, actor);
      await sendText(interaction, `✅ Moved **${team.teamNumber}** from ${seatName(from)} to ${seatName(to)}.`);
      return;
    }
  }

  if (group === 'team') {
    const draft = requireCurrentDraft(ctx, guildId);
    if (sub === 'add') {
      const team = service.engine.addTeam(
        draft.id,
        {
          teamNumber: interaction.options.getString('number', true),
          teamName: interaction.options.getString('name'),
          organization: interaction.options.getString('organization'),
          location: interaction.options.getString('location'),
        },
        actor,
      );
      await send(interaction, { content: `✅ Added team **${team.teamNumber}**.`, embeds: [teamEmbed(service.engine.getTeamInfo(draft.id, team.id))] });
      return;
    }
    if (sub === 'remove') {
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      const force = interaction.options.getBoolean('force') ?? false;
      await defer(interaction);
      const result = await service.removeTeam(draft.id, team.id, force, actor);
      await sendText(interaction, `✅ Removed **${team.teamNumber}** from the draft${result.droppedFrom.length ? ` and dropped it from ${result.droppedFrom.map((p) => p.label).join(', ')}` : ''}${result.prepicksRemoved ? ` (cleared from ${result.prepicksRemoved} prepick list(s))` : ''}.`);
      return;
    }
    if (sub === 'restore') {
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      await service.restoreTeam(draft.id, team.id, actor);
      await sendText(interaction, `✅ **${team.teamNumber}** is back in the pool.`);
      return;
    }
    if (sub === 'list') {
      const filter = (interaction.options.getString('filter') ?? '').toUpperCase();
      const availableOnly = interaction.options.getBoolean('available-only') ?? false;
      const config = repos.drafts.getConfig(draft.id);
      const teams = availableOnly ? repos.teams.listAvailable(draft.id, config.maxInstancesPerTeam, filter || undefined, 200) : repos.teams.listByDraft(draft.id).filter((t) => !filter || t.teamNumber.includes(filter) || (t.teamName ?? '').toUpperCase().includes(filter));
      const text = teams.map((t) => `${t.teamNumber}${t.teamName ? ` (${t.teamName})` : ''}`).join(', ');
      await send(interaction, { embeds: [{ title: `Teams${availableOnly ? ' available' : ''} (${teams.length})`, description: text.slice(0, 4000) || '_none_', color: Colors.neutral }] }, { ephemeral: true });
      return;
    }
  }

  if (group === 'pick') {
    const draft = requireOpenDraft(ctx, guildId);
    await defer(interaction);
    if (sub === 'force') {
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      const ref = interaction.options.getString('participant');
      const participant = ref ? resolveParticipantRef(ctx, draft, ref) : service.engine.currentTurn(draft.id)?.owner;
      if (!participant) throw new DraftError('INVALID_STATE', 'Nobody is on the clock; name the participant explicitly.');
      await service.pick(draft.id, { participantId: participant.id, teamId: team.id, actor, kind: 'forced' });
      await sendText(interaction, `✅ Entered **${team.teamNumber}** for ${seatName(participant)}.`);
      return;
    }
    if (sub === 'correct') {
      const overall = interaction.options.getInteger('pick', true);
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      await service.adminReplaceTeam(draft.id, { overallPick: overall }, team.id, actor);
      await sendText(interaction, `✅ Pick #${overall} corrected to **${team.teamNumber}**.`);
      return;
    }
  }

  if (group === 'repick') {
    const draft = requireCurrentDraft(ctx, guildId);
    if (sub === 'list') {
      const open = service.repicks.listOpen(draft.id);
      await send(interaction, { content: open.length ? `${open.length} open repick(s):` : 'No open repicks.', embeds: open.slice(0, 10).map(repickEmbed) }, { ephemeral: true });
      return;
    }
    await defer(interaction);
    if (sub === 'start') {
      const p = resolveParticipantRef(ctx, draft, interaction.options.getString('participant', true));
      const team = teamOrThrow(ctx, draft.id, interaction.options.getString('team', true));
      const view = await service.openRepick(draft.id, p.id, team.id, interaction.options.getString('reason'), actor);
      await send(interaction, { content: `🔁 Repick #${view.repick.id} opened. ${seatName(p)} can now choose a replacement for **${team.teamNumber}** with \`/pick\`.`, embeds: [repickEmbed(view)] });
      return;
    }
    const id = interaction.options.getInteger('id', true);
    if (sub === 'approve' || sub === 'deny') {
      const view = await service.resolveRepick(draft.id, id, sub === 'approve', interaction.options.getString('note'), actor);
      await send(interaction, { content: sub === 'approve' ? `✅ Repick #${id} approved.` : `❌ Repick #${id} denied; the drafter can choose again.`, embeds: [repickEmbed(view)] });
      return;
    }
    if (sub === 'cancel') {
      const view = await service.cancelRepick(draft.id, id, interaction.options.getBoolean('restore') ?? true, actor);
      await send(interaction, { content: `🚫 Repick #${id} cancelled.`, embeds: [repickEmbed(view)] });
      return;
    }
  }

  if (group === 'trade') {
    const draft = requireCurrentDraft(ctx, guildId);
    const config = repos.drafts.getConfig(draft.id);
    if (sub === 'list') {
      const open = service.trades.listOpen(draft.id);
      await send(interaction, { content: open.length ? `${open.length} pending trade(s):` : 'No pending trades.', embeds: open.slice(0, 10).map(tradeEmbed) }, { ephemeral: true });
      return;
    }
    const id = interaction.options.getInteger('id', true);
    await defer(interaction);
    const result = await service.adminResolveTrade(draft.id, id, sub === 'approve', actor);
    await send(interaction, { content: describeResolution(id, sub === 'approve' ? 'approve' : 'deny', result), embeds: [tradeEmbed(result.view)] });
    await refreshTradeMessage(ctx, draft.id, id, config.tradeApproval);
    return;
  }
  throw new DraftError('VALIDATION', 'Unknown command.');
}

/** Re-renders the trade's channel message (buttons removed once resolved). */
export async function refreshTradeMessage(ctx: BotContext, draftId: number, tradeId: number, approvalMode: DraftConfig['tradeApproval']): Promise<void> {
  const trade = ctx.service.repos.trades.getById(tradeId);
  if (!trade?.messageChannelId || !trade.messageId) return;
  const view = ctx.service.trades.view(draftId, tradeId);
  try {
    await ctx.service.announcer.update({ channelId: trade.messageChannelId, messageId: trade.messageId }, { embeds: [tradeEmbed(view)], buttons: tradeButtons(draftId, view, approvalMode), mentionUserIds: tradeMentions(view) });
  } catch (err) {
    ctx.logger.warn({ err, tradeId }, 'could not update trade message');
  }
}

async function autocomplete(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const draft = ctx.service.repos.drafts.getCurrentForGuild(interaction.guildId);
  if (!draft) return respondAutocomplete(interaction, []);
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  const q = String(focused.value);
  if (focused.name === 'zone') {
    const zones = Intl.supportedValuesOf('timeZone').filter((z) => z.toLowerCase().includes(q.toLowerCase())).slice(0, 25);
    return respondAutocomplete(interaction, zones.map((z) => ({ name: z, value: z })));
  }
  if (['participant', 'seat', 'from', 'to'].includes(focused.name)) {
    return respondAutocomplete(interaction, participantChoices(ctx, draft, q));
  }
  if (focused.name === 'team' || focused.name === 'new-team' || focused.name === 'old-team') {
    if (group === 'team' && sub === 'restore') return respondAutocomplete(interaction, teamChoices(ctx, draft, q, 'removed'));
    if (group === 'team' && sub === 'remove') return respondAutocomplete(interaction, teamChoices(ctx, draft, q, 'all'));
    if ((group === 'roster' && (sub === 'drop' || sub === 'move')) || (group === 'repick' && sub === 'start') || focused.name === 'old-team') {
      const ref = interaction.options.getString(sub === 'move' ? 'from' : 'participant');
      if (ref) {
        try {
          const p = resolveParticipantRef(ctx, draft, ref);
          return respondAutocomplete(interaction, rosterTeamChoices(ctx, draft, p.id, q));
        } catch {
          /* fall through to all teams */
        }
      }
      return respondAutocomplete(interaction, teamChoices(ctx, draft, q, 'all'));
    }
    return respondAutocomplete(interaction, teamChoices(ctx, draft, q, 'available'));
  }
  return respondAutocomplete(interaction, []);
}

export const draftCommand: Command = { data: data.toJSON(), execute, autocomplete };
