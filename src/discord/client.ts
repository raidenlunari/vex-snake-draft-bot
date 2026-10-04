import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import type { DraftService } from '../services/draftService.js';
import { commands } from './commands/index.js';
import { componentHandlers } from './components/index.js';
import type { BotContext } from './context.js';
import { sendError } from './respond.js';

export interface BotOptions {
  client: Client;
  env: Env;
  logger: Logger;
  service: DraftService;
}

/**
 * Only the Guilds intent is required: slash commands and components arrive over the
 * interactions gateway, and announcements are plain channel sends.
 */
export function createClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

/** Attaches interaction routing and lifecycle logging to the client. */
export function createBot(opts: BotOptions): { client: Client; ctx: BotContext } {
  const client = opts.client;
  const ctx: BotContext = { client, service: opts.service, logger: opts.logger, env: opts.env };
  const commandMap = new Map(commands.map((c) => [c.data.name, c]));
  const componentMap = new Map(componentHandlers.map((h) => [h.namespace, h]));

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void handleInteraction(interaction, ctx, commandMap, componentMap);
  });
  client.on(Events.Error, (err) => opts.logger.error({ err }, 'discord client error'));
  client.on(Events.Warn, (msg) => opts.logger.warn({ msg }, 'discord client warning'));
  client.on(Events.ShardDisconnect, (event, shardId) => opts.logger.warn({ shardId, code: event.code }, 'shard disconnected'));
  client.on(Events.ShardReconnecting, (shardId) => opts.logger.info({ shardId }, 'shard reconnecting'));
  client.on(Events.ShardResume, (shardId) => opts.logger.info({ shardId }, 'shard resumed'));
  return { client, ctx };
}

async function handleInteraction(
  interaction: Interaction,
  ctx: BotContext,
  commandMap: Map<string, (typeof commands)[number]>,
  componentMap: Map<string, (typeof componentHandlers)[number]>,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    if (interaction.isRepliable()) await interaction.reply({ content: 'This bot only works inside a server.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  const started = Date.now();
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) throw new Error(`Unknown command ${interaction.commandName}`);
      ctx.logger.info({ command: interaction.commandName, sub: interaction.options.getSubcommand(false), user: interaction.user.id, guild: interaction.guildId }, 'command');
      await command.execute(interaction, ctx);
    } else if (interaction.isAutocomplete()) {
      const command = commandMap.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction, ctx);
      else await interaction.respond([]).catch(() => undefined);
    } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      const [namespace, ...args] = interaction.customId.split(':');
      const handler = namespace ? componentMap.get(namespace) : undefined;
      if (!handler) throw new Error(`Unknown component ${interaction.customId}`);
      ctx.logger.info({ component: interaction.customId, user: interaction.user.id, guild: interaction.guildId }, 'component');
      await handler.execute(interaction, args, ctx);
    }
  } catch (err) {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    if (interaction.isChatInputCommand() || interaction.isMessageComponent() || interaction.isModalSubmit()) await sendError(interaction, err, ctx.logger);
    else ctx.logger.error({ err }, 'interaction failed');
  } finally {
    ctx.logger.debug({ ms: Date.now() - started, type: interaction.type }, 'interaction handled');
  }
}
