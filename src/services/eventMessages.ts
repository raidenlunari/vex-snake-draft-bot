import { formatDuration } from '../domain/config.js';
import type { DraftConfig, ParticipantWithUsers } from '../domain/types.js';
import { mentionSeat } from '../engine/draftEngine.js';
import type { DraftEvent } from '../engine/events.js';
import { Colors, type AnnouncementPayload } from './announcer.js';

function userIds(p: ParticipantWithUsers): string[] {
  return p.users.map((u) => u.discordUserId);
}

export function discordTimestamp(iso: string, style: 'R' | 'f' | 't' = 'R'): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
}

/**
 * Renders engine events into channel announcements. Consecutive events are merged
 * where it reads better (a pick followed by the next turn becomes one message).
 */
export function renderEvents(events: DraftEvent[], config: DraftConfig): AnnouncementPayload[] {
  const out: AnnouncementPayload[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'draft_started': {
        const order = event.order.map((p, i) => `${i + 1}. ${mentionSeat(p)}`).join('\n');
        out.push({
          content: `🏁 **The draft has started!** ${event.totalPicks} picks over ${config.rounds} round(s)${config.snakeOrder ? ' in snake order' : ''}.`,
          embeds: [{ title: 'Draft order', description: order, color: Colors.info }],
          mentionUserIds: event.order.flatMap(userIds),
        });
        break;
      }
      case 'pick_made': {
        const who = mentionSeat(event.participant);
        const where = event.slot ? `Round ${event.slot.round}, pick #${event.slot.overallPick}` : 'Admin addition';
        const how =
          event.kind === 'prepick' ? ' (auto-pick from prepicks)' : event.kind === 'forced' ? ' (entered by an admin)' : event.kind === 'catch_up' ? ' (catch-up pick)' : event.kind === 'admin_add' ? ' (added by an admin)' : '';
        const name = event.team.teamName ? ` — ${event.team.teamName}` : '';
        out.push({
          content: `✅ **${where}:** ${who} selected **${event.team.teamNumber}**${name}${how}`,
          mentionUserIds: [],
        });
        break;
      }
      case 'turn_started': {
        const who = mentionSeat(event.participant);
        const lines = [`🎯 **Round ${event.slot.round}, pick #${event.slot.overallPick} of ${event.totalPicks}** — it's ${who}'s turn!`];
        if (event.picksThisTurn > 1) lines.push(`This is pick ${event.pickIndexInTurn} of ${event.picksThisTurn} this turn.`);
        if (event.deadline && config.skipTimerSeconds) {
          const hours = config.skipHoursStart && config.skipHoursEnd ? ` (timer runs ${config.skipHoursStart}–${config.skipHoursEnd} ${config.timezone})` : '';
          lines.push(`⏳ Timer started: ${formatDuration(config.skipTimerSeconds)}${hours}. Auto-skip ${discordTimestamp(event.deadline)}.`);
        }
        lines.push('Use `/pick` to choose a team.');
        out.push({ content: lines.join('\n'), mentionUserIds: userIds(event.participant) });
        break;
      }
      case 'turn_skipped': {
        const who = mentionSeat(event.participant);
        const why = event.reason === 'timer' ? 'the timer expired' : 'an admin skipped the turn';
        const next = event.catchUpAllowed ? ` ${who} can still use \`/pick\` later to fill pick #${event.slot.overallPick}.` : ' The pick is forfeited.';
        out.push({ content: `⏭️ **Pick #${event.slot.overallPick} skipped:** ${who} — ${why}.${next}`, mentionUserIds: userIds(event.participant) });
        break;
      }
      case 'prepick_dropped':
        out.push({ content: `ℹ️ Prepick **${event.team.teamNumber}** for ${mentionSeat(event.participant)} was skipped: ${event.reason}.`, mentionUserIds: [] });
        break;
      case 'draft_completed': {
        const forfeited = event.forfeited.length ? `\nForfeited picks: ${event.forfeited.map((s) => `#${s.overallPick}`).join(', ')}.` : '';
        const why = event.reason === 'pool_empty' ? ' (no teams left in the pool)' : event.reason === 'admin' ? ' (ended by an admin)' : '';
        out.push({ content: `🏆 **The draft is complete!**${why}${forfeited}\nUse \`/roster\` to see final rosters.`, mentionUserIds: [] });
        break;
      }
      case 'pick_corrected':
        out.push({
          content: `✏️ **Correction:** ${event.slot ? `pick #${event.slot.overallPick}` : 'a roster entry'} for ${mentionSeat(event.participant)} changed from **${event.oldTeam.teamNumber}** to **${event.newTeam.teamNumber}** (by an admin).`,
          mentionUserIds: [],
        });
        break;
      case 'roster_changed':
        out.push({ content: `🛠️ **Roster update:** ${event.summary}.`, mentionUserIds: [] });
        break;
      case 'trade_executed':
        out.push({ content: `🤝 **Trade #${event.trade.id} completed:** ${event.summary}.`, mentionUserIds: [] });
        break;
      case 'trade_failed':
        out.push({ content: `⚠️ Trade #${event.trade.id} could not be completed: ${event.reason}`, mentionUserIds: [] });
        break;
      default:
        break;
    }
  }
  return mergePickAndTurn(out);
}

/** Joins "pick made" + "turn started" into one message to reduce channel noise. */
function mergePickAndTurn(payloads: AnnouncementPayload[]): AnnouncementPayload[] {
  const merged: AnnouncementPayload[] = [];
  for (const p of payloads) {
    const prev = merged[merged.length - 1];
    if (prev && prev.content && p.content && !prev.embeds && !p.embeds && prev.content.startsWith('✅') && p.content.startsWith('🎯')) {
      merged[merged.length - 1] = {
        content: `${prev.content}\n\n${p.content}`,
        mentionUserIds: [...(prev.mentionUserIds ?? []), ...(p.mentionUserIds ?? [])],
      };
      continue;
    }
    merged.push(p);
  }
  return merged;
}
