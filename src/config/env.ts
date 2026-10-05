import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_GUILD_ID: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  REGISTER_COMMANDS_ON_START: boolish.default(true),
  DATABASE_PATH: z.string().default('./data/draft.db'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: boolish.default(false),
  DEFAULT_TIMEZONE: z.string().default('UTC'),
  /** Path to a Google service-account JSON key; enables Google Sheets sync. */
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /** Alternatively the JSON key itself (useful for container secrets). */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  SHEET_SYNC_DEBOUNCE_MS: z.coerce.number().int().min(0).default(1500),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
