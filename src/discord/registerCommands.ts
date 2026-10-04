import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadEnv, type Env } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import { createLogger } from '../logging/logger.js';
import { commands } from './commands/index.js';

/**
 * Registers slash commands. With DISCORD_GUILD_ID set they are registered to that guild
 * (instant); otherwise globally (can take up to an hour to propagate).
 */
export async function registerCommands(env: Env, logger: Logger): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  const body = commands.map((c) => c.data);
  if (env.DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body });
    logger.info({ count: body.length, guildId: env.DISCORD_GUILD_ID }, 'registered guild slash commands');
  } else {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
    logger.info({ count: body.length }, 'registered global slash commands');
  }
}

const isMain = process.argv[1] && /registerCommands\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  registerCommands(env, logger)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error({ err }, 'command registration failed');
      process.exit(1);
    });
}
