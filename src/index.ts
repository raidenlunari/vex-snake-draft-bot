import 'dotenv/config';
import { Events } from 'discord.js';
import { loadEnv } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { createRepositories } from './db/repositories/index.js';
import { createBot, createClient } from './discord/client.js';
import { DiscordAnnouncer } from './discord/announcer.js';
import { registerCommands } from './discord/registerCommands.js';
import { CsvImporter } from './engine/csvImport.js';
import { DraftEngine } from './engine/draftEngine.js';
import { PrepickService } from './engine/prepickService.js';
import { TradeEngine } from './engine/tradeEngine.js';
import { createLogger } from './logging/logger.js';
import { DraftService } from './services/draftService.js';
import { TurnTimerService } from './services/timerService.js';
import { systemClock } from './util/clock.js';
import { secureRandom } from './util/random.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  logger.info({ databasePath: env.DATABASE_PATH }, 'starting vex-snake-draft-bot');

  const db = openDatabase(env.DATABASE_PATH);
  const repos = createRepositories(db);
  const clock = systemClock;
  const engine = new DraftEngine({ repos, clock, random: secureRandom });

  // The service and timer service reference each other; the callback resolves `service`
  // lazily, after it is constructed below.
  const timers = new TurnTimerService({
    repos,
    clock,
    logger,
    onExpire: async (draftId, token) => {
      await service.handleTimerExpiry(draftId, token);
    },
  });

  const client = createClient();
  const announcer = new DiscordAnnouncer(client, logger);
  const service = new DraftService({
    repos,
    engine,
    trades: new TradeEngine(repos, clock),
    prepicks: new PrepickService(repos, clock),
    importer: new CsvImporter(repos, clock),
    timers,
    announcer,
    logger,
  });
  const bootstrap = createBot({ client, env, logger, service });

  if (env.REGISTER_COMMANDS_ON_START) {
    await registerCommands(env, logger);
  }

  bootstrap.client.once(Events.ClientReady, async () => {
    logger.info({ user: bootstrap.client.user?.tag, guilds: bootstrap.client.guilds.cache.size }, 'discord client ready');
    try {
      await timers.recoverAll();
      timers.startSweep();
    } catch (err) {
      logger.error({ err }, 'timer recovery failed');
    }
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    timers.stop();
    bootstrap.client.destroy();
    try {
      db.close();
    } catch (err) {
      logger.warn({ err }, 'error closing database');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });

  await bootstrap.client.login(env.DISCORD_TOKEN);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
