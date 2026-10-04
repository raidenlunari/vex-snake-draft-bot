import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Env } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import type { DraftService } from '../services/draftService.js';

export interface BotContext {
  client: Client;
  service: DraftService;
  logger: Logger;
  env: Env;
}

export interface Command {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<'cached'>, ctx: BotContext): Promise<void>;
}

export interface ComponentHandler {
  /** First segment of the customId ("pick", "trade", ...). */
  namespace: string;
  execute(interaction: MessageComponentInteraction<'cached'> | ModalSubmitInteraction<'cached'>, args: string[], ctx: BotContext): Promise<void>;
}

export function customId(namespace: string, ...args: Array<string | number | boolean>): string {
  const id = [namespace, ...args.map(String)].join(':');
  if (id.length > 100) throw new Error(`customId too long: ${id}`);
  return id;
}
