import type { DraftConfig, ParticipantWithUsers } from '../domain/types.js';
import { mentionSeat } from '../engine/draftEngine.js';
import type { DraftEvent } from '../engine/events.js';
import { Colors, type AnnouncementPayload } from './announcer.js';

function userIds(p: ParticipantWithUsers): string[] {
  return p.users.map((u) => u.discordUserId);
}

/** A seat named without pinging anyone. */
function plainSeat(p: ParticipantWithUsers): string {
  return p.label;
}

export function discordTimestamp(iso: string, style: 'R' | 'f' | 't' = 'R'): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
}

/**
 * Renders engine events into channel announcements. Consecutive events are merged
 * where it reads better (a pick followed by the next turn becomes one message).
 */
type TaggedPayload = AnnouncementPayload & { kind?: 'pick' | 'turn' };

export function renderEvents(events: DraftEvent[], config: DraftConfig): AnnouncementPayload[] {
  const out: TaggedPayload[] = [];
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
        const how =
          event.kind === 'prepick' ? ' (prepick)' : event.kind === 'forced' ? ' (entered by an admin)' : event.kind === 'catch_up' ? ' (catch-up for pick #' + (event.slot?.overallPick ?? '?') + ')' : event.kind === 'admin_add' ? ' (added by an admin)' : '';
        out.push({ kind: 'pick', content: `${plainSeat(event.participant)} picked **${event.team.teamNumber}**${how}.`, mentionUserIds: [] });
        break;
      }
      case 'turn_started': {
        const [onDeck, inHole, fourth, fifth] = event.upcoming;
        const lines = [`${mentionSeat(event.participant)} is up.`];
        if (event.picksThisTurn > 1) lines[0] += ` (pick ${event.pickIndexInTurn} of ${event.picksThisTurn})`;
        if (onDeck) lines.push(`${mentionSeat(onDeck)} is on deck.`);
        if (inHole) lines.push(`${mentionSeat(inHole)} is in the hole.`);
        if (fourth) lines.push(`${plainSeat(fourth)} is 4th.`);
        if (fifth) lines.push(`${plainSeat(fifth)} is 5th.`);
        if (event.deadline && config.skipTimerSeconds) lines.push(`Auto-skip ${discordTimestamp(event.deadline)}.`);
        const pinged = [event.participant, onDeck, inHole].filter((p): p is ParticipantWithUsers => !!p).flatMap(userIds);
        out.push({ kind: 'turn', content: lines.join('\n'), mentionUserIds: pinged });
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
      case 'repick_opened': {
        const where = event.slot ? ` (pick #${event.slot.overallPick}, round ${event.slot.round})` : '';
        out.push({
          content: `🔁 **Repick #${event.repick.id} opened** for ${mentionSeat(event.participant)}: team **${event.oldTeam.teamNumber}** is out${where}${event.repick.reason ? ` — ${event.repick.reason}` : ''}.\nChoose a replacement with \`/pick\`; an admin will approve it.`,
          mentionUserIds: userIds(event.participant),
        });
        break;
      }
      case 'repick_proposed':
        out.push({
          content: `🔁 **Repick #${event.repick.id}:** ${mentionSeat(event.participant)} wants **${event.newTeam.teamNumber}**${event.newTeam.teamName ? ` (${event.newTeam.teamName})` : ''} to replace ${event.oldTeam.teamNumber}${event.slot ? ` at pick #${event.slot.overallPick}` : ''}. Waiting for an admin.`,
          buttons: [
            { id: `repick:approve:${event.draftId}:${event.repick.id}`, label: 'Approve (admin)', style: 'success', emoji: '✅' },
            { id: `repick:deny:${event.draftId}:${event.repick.id}`, label: 'Deny (admin)', style: 'danger', emoji: '❌' },
          ],
          mentionUserIds: [],
        });
        break;
      case 'repick_completed':
        out.push({
          content: `✅ **Repick #${event.repick.id} approved:** ${mentionSeat(event.participant)} now has **${event.newTeam.teamNumber}** in place of ${event.oldTeam.teamNumber}${event.slot ? ` (pick #${event.slot.overallPick})` : ''}.`,
          mentionUserIds: userIds(event.participant),
        });
        break;
      case 'repick_denied':
        out.push({
          content: `❌ **Repick #${event.repick.id}:** an admin denied **${event.team.teamNumber}**${event.note ? ` — ${event.note}` : ''}. ${mentionSeat(event.participant)}, choose another team with \`/pick\`.`,
          mentionUserIds: userIds(event.participant),
        });
        break;
      case 'repick_cancelled':
        out.push({
          content: `🚫 **Repick #${event.repick.id} cancelled** for ${mentionSeat(event.participant)}${event.restored ? `; ${event.oldTeam.teamNumber} is back on the roster` : ''}.`,
          mentionUserIds: userIds(event.participant),
        });
        break;
      default:
        break;
    }
  }
  return mergePickAndTurn(out);
}

/** Joins "pick made" + "turn started" into one message to reduce channel noise. */
function mergePickAndTurn(payloads: TaggedPayload[]): AnnouncementPayload[] {
  const merged: TaggedPayload[] = [];
  for (const p of payloads) {
    const prev = merged[merged.length - 1];
    if (prev && prev.content && p.content && !prev.embeds && !p.embeds && prev.kind === 'pick' && p.kind === 'turn') {
      merged[merged.length - 1] = {
        content: `${prev.content}\n${p.content}`,
        mentionUserIds: [...(prev.mentionUserIds ?? []), ...(p.mentionUserIds ?? [])],
      };
      continue;
    }
    merged.push(p);
  }
  return merged.map(({ kind: _kind, ...rest }) => rest);
}
