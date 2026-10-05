import type { Command } from '../context.js';
import { draftCommand } from './draft.js';
import { pickCommand } from './pick.js';
import { prepicksCommand } from './prepicks.js';
import { repickCommand } from './repick.js';
import { rosterCommand } from './roster.js';
import { statusCommand } from './status.js';
import { swapCommand } from './swap.js';
import { teamCommand } from './team.js';
import { teamsCommand } from './teams.js';
import { tradeCommand } from './trade.js';

export const commands: Command[] = [draftCommand, statusCommand, pickCommand, prepicksCommand, repickCommand, rosterCommand, swapCommand, teamCommand, teamsCommand, tradeCommand];
