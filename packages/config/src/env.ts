import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  REDIS_URL: z.url().startsWith('redis://'),
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).max(256),
  PUBLIC_BASE_URL: z.url().startsWith('https://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
});

export type AppEnv = z.infer<typeof schema>;

export const parseEnv = (input: NodeJS.ProcessEnv): AppEnv =>
  schema.parse(input);
