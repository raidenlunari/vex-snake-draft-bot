import { describeConfig, formatDuration } from '../../domain/config.js';
import { remainingActiveSeconds } from '../../domain/activeHours.js';
import type { AuditEvent, Draft, DraftConfig, ParticipantWithUsers, Team } from '../../domain/types.js';
import type { ImportSummary } from '../../engine/csvImport.js';
import { mentionSeat, type DraftEngine, type DraftStateView, type RosterView, type StartValidation, type TeamInfoView } from '../../engine/draftEngine.js';
import type { PrepickEntry } from '../../engine/prepickService.js';
import type { RepickView } from '../../engine/repickEngine.js';
import type { TradeView } from '../../engine/tradeEngine.js';
import { Colors, type ButtonSpec, type EmbedPayload } from '../../services/announcer.js';
import { discordTimestamp } from '../../services/eventMessages.js';
import { describeStatus } from '../../engine/context.js';
import { customId } from '../context.js';

export function seatName(p: ParticipantWithUsers | null): string {
  return p ? mentionSeat(p) : '—';
}

export function teamLabel(t: Team): string {
  return t.teamName ? `**${t.teamNumber}** — ${t.teamName}` : `**${t.teamNumber}**`;
}

function fit(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width);
}

/**
 * Sheet-style status: one header line, then a monospace grid of drafters by pick
 * (the layout of the club's Google Sheet), with the drafter on the clock marked ▶.
 */
export function statusEmbed(state: DraftStateView, nowIso: string): EmbedPayload {
  const { draft, config, currentSlot, currentOwner } = state;
  const window = config.skipHoursStart && config.skipHoursEnd ? { start: config.skipHoursStart, end: config.skipHoursEnd, timezone: config.timezone } : null;

  const head: string[] = [];
  if (draft.status === 'active' && currentSlot) {
    head.push(`**Round ${currentSlot.round} / ${config.rounds}** · Pick **#${currentSlot.overallPick}** of ${state.totalSlots} · ${state.availableTeams} teams left`);
    let clock = '';
    if (draft.turnDeadlineAt) {
      const r = remainingActiveSeconds(nowIso, draft.turnDeadlineAt, window);
      clock = r.paused && r.resumesAt ? ` · timer paused until ${discordTimestamp(r.resumesAt, 't')}` : ` · auto-skip ${discordTimestamp(draft.turnDeadlineAt)}`;
    }
    head.push(`▶ ${seatName(currentOwner)} is up${clock}`);
  } else {
    const status = draft.status === 'completed' ? `Draft complete · ${state.resolvedSlots} picks` : draft.status === 'randomized' ? 'Order set — waiting for an admin to start' : `Setting up · ${state.participants.length} drafters · ${state.totalTeams} teams`;
    head.push(`**${status}**`);
  }

  const picksPerSeat = config.rounds * config.picksPerRound;
  const columns = Math.max(picksPerSeat, ...state.grid.map((g) => g.picks.length), 1);
  const cellWidth = Math.max(6, ...state.grid.flatMap((g) => g.picks.map((p) => p.length)));
  const labelWidth = Math.min(16, Math.max(7, ...state.grid.map((g) => g.participant.label.length + 2)));
  const skippedBySeat = new Map<number, number>();
  for (const s of state.openSkippedSlots) skippedBySeat.set(s.owner.id, (skippedBySeat.get(s.owner.id) ?? 0) + 1);

  const lines: string[] = [];
  lines.push(fit('Drafter', labelWidth) + ' ' + Array.from({ length: columns }, (_, i) => fit(`P${i + 1}`, cellWidth)).join(' '));
  for (const row of state.grid) {
    const marker = currentOwner && row.participant.id === currentOwner.id ? '▶ ' : '  ';
    const cells = Array.from({ length: columns }, (_, i) => row.picks[i] ?? '');
    let open = skippedBySeat.get(row.participant.id) ?? 0;
    for (let i = 0; i < cells.length && open > 0; i++) {
      if (cells[i] === '') {
        cells[i] = 'skip';
        open -= 1;
      }
    }
    lines.push(fit(marker + row.participant.label, labelWidth) + ' ' + cells.map((c) => fit(c, cellWidth)).join(' '));
  }
  let grid = '```\n' + lines.join('\n') + '\n```';
  if (grid.length > 3800) grid = '```\n' + lines.slice(0, 40).join('\n') + '\n…\n```';

  const tail: string[] = [];
  if (state.openSkippedSlots.length) tail.push(`"skip" = open catch-up pick (use /pick)`);
  tail.push('`/teams` shows what is left · `/roster` for details');

  return {
    title: `${draft.name}`,
    description: [...head, grid, ...tail].join('\n'),
    color: draft.status === 'active' ? Colors.info : draft.status === 'completed' ? Colors.success : Colors.neutral,
    footer: `${config.snakeOrder ? 'Snake' : 'Fixed'} order · ${config.picksPerRound} pick(s) per turn · ${picksPerSeat} per drafter${config.skipTimerSeconds ? ` · timer ${timerSummary(config)}` : ''}`,
  };
}

export function statusButtons(draftId: number): ButtonSpec[] {
  return [
    { id: customId('view', 'refresh', draftId), label: 'Refresh', style: 'secondary', emoji: '🔄' },
    { id: customId('view', 'roster', draftId), label: 'My roster', style: 'primary', emoji: '📋' },
    { id: customId('view', 'prepicks', draftId), label: 'My prepicks', style: 'primary', emoji: '📝' },
    { id: customId('view', 'order', draftId), label: 'Draft order', style: 'secondary', emoji: '🔢' },
    { id: customId('view', 'rosters', draftId), label: 'All rosters', style: 'secondary', emoji: '👥' },
    { id: customId('teams', 'page', draftId, 0, 'grid'), label: 'Available teams', style: 'secondary', emoji: '🤖' },
  ];
}

export function rosterEmbed(view: RosterView): EmbedPayload {
  const lines = view.teams.map((t) => {
    const where = t.overallPick ? `#${t.overallPick} (R${t.round})` : 'admin';
    const extras: string[] = [];
    if (t.originalOwner) extras.push(`originally ${t.originalOwner.label}`);
    for (const tr of t.transfers) {
      extras.push(tr.reason === 'trade' ? `trade #${tr.tradeId}: ${tr.from?.label ?? '?'} → ${tr.to?.label ?? '?'}` : `moved by admin: ${tr.from?.label ?? '?'} → ${tr.to?.label ?? '?'}`);
    }
    return `\`${where.padEnd(9)}\` ${teamLabel(t.team)}${extras.length ? ` _(${extras.join('; ')})_` : ''}`;
  });
  const fields: EmbedPayload['fields'] = [];
  if (view.futurePicks.length) {
    fields.push({
      name: 'Remaining picks',
      value: view.futurePicks
        .map((p) => `#${p.overallPick} (R${p.round})${p.originalOwner ? ` from ${p.originalOwner.label}` : ''}${p.slotStatus === 'skipped' ? ' — skipped, catch-up available' : p.slotStatus === 'current' ? ' — on the clock' : ''}`)
        .join('\n'),
    });
  }
  return {
    title: `Roster — ${view.participant.label}`,
    description: `${seatName(view.participant)}\n\n${lines.length ? lines.join('\n') : '_No teams yet._'}`,
    color: Colors.info,
    fields,
    footer: `${view.totalPicks} team(s)${view.maxRoster ? ` · max roster ${view.maxRoster}` : ''}`,
  };
}

export function allRostersEmbed(draft: Draft, rosters: RosterView[]): EmbedPayload {
  return {
    title: `All rosters — ${draft.name}`,
    color: Colors.info,
    fields: rosters.map((r) => ({
      name: `${r.participant.draftPosition ? `#${r.participant.draftPosition} ` : ''}${r.participant.label} (${r.totalPicks})`,
      value: r.teams.length ? r.teams.map((t) => t.team.teamNumber).join(', ') : '—',
      inline: true,
    })),
  };
}

export function teamEmbed(info: TeamInfoView): EmbedPayload {
  const t = info.team;
  const lines = [`**Available:** ${info.removed ? 'No (removed from draft)' : info.available ? 'Yes' : 'No'}`];
  if (t.teamName) lines.push(`**Name:** ${t.teamName}`);
  if (t.organization) lines.push(`**Organization:** ${t.organization}`);
  if (t.location) lines.push(`**Location:** ${t.location}`);
  if (t.extra) for (const [k, v] of Object.entries(t.extra)) lines.push(`**${k}:** ${v}`);
  if (info.owners.length) {
    lines.push('', '**Owned by:**');
    for (const o of info.owners) {
      const where = o.overallPick ? `Pick #${o.overallPick} (R${o.round})` : 'added by admin';
      const trade = o.viaTrade ? ` · via trade${o.originalOwner ? ` from ${o.originalOwner.label}` : ''}` : '';
      lines.push(`- ${seatName(o.participant)} — ${where}${trade}`);
    }
  }
  if (info.maxInstances > 1) lines.push('', `**Instances:** ${info.instancesUsed} / ${info.maxInstances}`);
  return { title: `Team ${t.teamNumber}`, description: lines.join('\n'), color: info.available ? Colors.success : Colors.neutral };
}

export function configEmbed(draft: Draft, config: DraftConfig, participants: ParticipantWithUsers[], teamCount: number, adminRoleId: string | null): EmbedPayload {
  const rows = describeConfig(config).map(([k, v]) => `**${k}:** ${v}`);
  rows.push(`**Admin role:** ${adminRoleId ? `<@&${adminRoleId}>` : 'none (Manage Server only)'}`);
  rows.push(`**Channel:** ${draft.channelId ? `<#${draft.channelId}>` : 'not set'}`);
  return {
    title: `Configuration — ${draft.name}`,
    description: rows.join('\n'),
    color: Colors.neutral,
    fields: [
      { name: 'Participants', value: participants.length ? participants.map((p) => `${p.draftPosition ? `#${p.draftPosition} ` : ''}${p.label}`).join(', ') : 'none', inline: false },
      { name: 'Teams', value: String(teamCount), inline: true },
      { name: 'Status', value: describeStatus(draft.status), inline: true },
    ],
  };
}

export function participantsEmbed(draft: Draft, participants: ParticipantWithUsers[]): EmbedPayload {
  return {
    title: `Participants — ${draft.name}`,
    description: participants.length
      ? participants.map((p) => `${p.draftPosition ? `**#${p.draftPosition}** ` : '• '}${p.label} — ${p.users.length ? p.users.map((u) => `<@${u.discordUserId}>`).join(', ') : '_no user_'}`).join('\n')
      : '_No participants yet. Use `/draft participant add`._',
    color: Colors.neutral,
    footer: `${participants.length} seat(s)`,
  };
}

export function orderEmbed(draft: Draft, participants: ParticipantWithUsers[], validation?: StartValidation): EmbedPayload {
  const fields: EmbedPayload['fields'] = [];
  if (validation?.errors.length) fields.push({ name: '❌ Blocking problems', value: validation.errors.map((e) => `• ${e}`).join('\n') });
  if (validation?.warnings.length) fields.push({ name: '⚠️ Warnings', value: validation.warnings.map((w) => `• ${w}`).join('\n') });
  return {
    title: `Draft order — ${draft.name}`,
    description: participants.map((p, i) => `**${i + 1}.** ${seatName(p)}`).join('\n') || '_No order yet._',
    color: Colors.info,
    fields,
  };
}

export function fullOrderEmbed(draft: Draft, config: DraftConfig, rows: ReturnType<DraftEngine['getOrder']>): EmbedPayload {
  const byRound = new Map<number, string[]>();
  for (const r of rows) {
    const list = byRound.get(r.slot.round) ?? [];
    const owner = r.currentOwner.id === r.originalOwner.id ? r.currentOwner.label : `${r.currentOwner.label} (from ${r.originalOwner.label})`;
    const status = r.team ? `→ ${r.team.teamNumber}` : r.slot.status === 'current' ? '⏳' : r.slot.status === 'skipped' ? '⏭️ open' : r.slot.status === 'forfeited' ? '✖ forfeited' : r.slot.status === 'void' ? '—' : '';
    list.push(`#${r.slot.overallPick} ${owner} ${status}`.trim());
    byRound.set(r.slot.round, list);
  }
  return {
    title: `Pick order — ${draft.name}`,
    color: Colors.neutral,
    fields: [...byRound.entries()].slice(0, 25).map(([round, list]) => ({ name: `Round ${round}`, value: list.join('\n').slice(0, 1024), inline: true })),
    footer: `${rows.length} picks · ${config.snakeOrder ? 'snake' : 'fixed'} order`,
  };
}

export function prepicksEmbed(participant: ParticipantWithUsers, entries: PrepickEntry[]): EmbedPayload {
  return {
    title: `Prepicks — ${participant.label}`,
    description: entries.length
      ? entries.map((e, i) => `**${i + 1}.** ${teamLabel(e.team)}${e.available ? '' : ' ~~unavailable~~'}`).join('\n')
      : '_No prepicks. Add some with `/prepicks add` and the bot will pick for you when your turn comes._',
    color: Colors.info,
    footer: `${entries.length} prepick(s) · highest priority first`,
  };
}

export function tradeEmbed(view: TradeView): EmbedPayload {
  const { trade } = view;
  const statusText: Record<string, string> = {
    proposed: '⏳ Waiting for the other side to accept',
    accepted: '🛡️ Accepted — waiting for admin approval',
    executed: '✅ Completed',
    rejected: '❌ Rejected',
    cancelled: '🚫 Cancelled',
    denied: '⛔ Denied by an admin',
    failed: '⚠️ Failed validation',
  };
  const color = trade.status === 'executed' ? Colors.success : trade.status === 'proposed' || trade.status === 'accepted' ? Colors.warning : Colors.danger;
  return {
    title: `Trade #${trade.id}`,
    description: `${statusText[trade.status] ?? trade.status}${trade.note ? `\n> ${trade.note}` : ''}${trade.resolutionNote && trade.status !== 'executed' ? `\n_${trade.resolutionNote}_` : ''}`,
    color,
    fields: [
      { name: `${view.proposer.label} gives`, value: view.gives.map((g) => `• ${g.label}`).join('\n') || '—', inline: true },
      { name: `${view.counterparty.label} gives`, value: view.receives.map((g) => `• ${g.label}`).join('\n') || '—', inline: true },
    ],
    footer: `Proposed by ${view.proposer.label} · ${new Date(trade.createdAt).toUTCString()}`,
  };
}

export function tradeButtons(draftId: number, view: TradeView, approvalMode: DraftConfig['tradeApproval']): ButtonSpec[] {
  const t = view.trade;
  if (t.status === 'proposed') {
    return [
      { id: customId('trade', 'accept', draftId, t.id), label: 'Accept', style: 'success', emoji: '✅' },
      { id: customId('trade', 'reject', draftId, t.id), label: 'Reject', style: 'danger', emoji: '❌' },
      { id: customId('trade', 'cancel', draftId, t.id), label: 'Cancel', style: 'secondary' },
    ];
  }
  if (t.status === 'accepted' && approvalMode === 'admin') {
    return [
      { id: customId('trade', 'approve', draftId, t.id), label: 'Approve (admin)', style: 'success', emoji: '🛡️' },
      { id: customId('trade', 'deny', draftId, t.id), label: 'Deny (admin)', style: 'danger' },
      { id: customId('trade', 'cancel', draftId, t.id), label: 'Cancel', style: 'secondary' },
    ];
  }
  return [];
}

export function tradeMentions(view: TradeView): string[] {
  return [...view.proposer.users, ...view.counterparty.users].map((u) => u.discordUserId);
}

export function importSummaryEmbed(summary: ImportSummary): EmbedPayload {
  const list = (items: string[], max = 40): string => (items.length ? items.slice(0, max).join(', ') + (items.length > max ? ` … (+${items.length - max})` : '') : '—');
  return {
    title: 'Team import summary',
    color: summary.failed.length || summary.duplicates.length ? Colors.warning : Colors.success,
    description: `Rows processed: **${summary.totalRows}**`,
    fields: [
      { name: `✅ Imported (${summary.imported.length})`, value: list(summary.imported) },
      { name: `✏️ Updated (${summary.updated.length})`, value: list(summary.updated) },
      { name: `⏭️ Skipped (${summary.skipped.length})`, value: list(summary.skipped.map((s) => `${s.teamNumber} (${s.reason})`), 15) },
      { name: `❌ Failed (${summary.failed.length})`, value: list(summary.failed.map((f) => `line ${f.line}: ${f.reason}`), 15) },
      { name: `♻️ Duplicates in file (${summary.duplicates.length})`, value: list(summary.duplicates.map((d) => `${d.teamNumber} (line ${d.line}, first on ${d.firstLine})`), 15) },
    ],
  };
}

export function auditEmbed(draft: Draft, events: AuditEvent[]): EmbedPayload {
  return {
    title: `Audit log — ${draft.name}`,
    description: events.length
      ? events.map((e) => `\`${e.id}\` ${discordTimestamp(e.createdAt, 'f')} **${e.eventType}** by ${e.actorKind === 'system' ? 'system' : `<@${e.actorId}>`}\n${e.summary}`).join('\n').slice(0, 4000)
      : '_No events._',
    color: Colors.neutral,
  };
}

export function timerSummary(config: DraftConfig): string {
  if (!config.skipTimerSeconds) return 'off';
  const hours = config.skipHoursStart && config.skipHoursEnd ? ` during ${config.skipHoursStart}–${config.skipHoursEnd} ${config.timezone}` : '';
  return `${formatDuration(config.skipTimerSeconds)}${hours}`;
}

export function repickEmbed(view: RepickView): EmbedPayload {
  const { repick } = view;
  const status: Record<string, string> = {
    open: '⏳ Waiting for the drafter to choose a replacement (`/pick`)',
    proposed: '🛡️ Replacement chosen — waiting for admin approval',
    approved: '✅ Approved',
    cancelled: '🚫 Cancelled',
  };
  return {
    title: `Repick #${repick.id} — ${view.participant.label}`,
    description: [
      status[repick.status] ?? repick.status,
      `**Out:** ${teamLabel(view.oldTeam)}${view.slot ? ` (pick #${view.slot.overallPick}, R${view.slot.round})` : ''}`,
      view.proposedTeam ? `**Proposed:** ${teamLabel(view.proposedTeam)}` : '',
      repick.reason ? `**Reason:** ${repick.reason}` : '',
      repick.resolutionNote ? `_${repick.resolutionNote}_` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    color: repick.status === 'approved' ? Colors.success : repick.status === 'cancelled' ? Colors.danger : Colors.warning,
  };
}
