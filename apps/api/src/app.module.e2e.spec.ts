import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATABASE_POOL } from './infrastructure/infrastructure.module.js';
import { AppModule } from './app.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { V1Module } from './v1/v1.module.js';

let module: TestingModule | undefined;
let previousEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/volley',
    REDIS_URL: 'redis://127.0.0.1:6379',
    BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd',
    TELEGRAM_WEBHOOK_SECRET: '0123456789abcdef',
    PUBLIC_BASE_URL: 'https://localhost:3000',
    LOG_LEVEL: 'info',
  });
});

afterEach(async () => {
  await module?.close();
  module = undefined;
  process.env = previousEnv;
});

it('production AppModule shares one process-scoped PostgreSQL pool', async () => {
  module = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const rootPool = module.get(DATABASE_POOL);
  const telegramPool = module.select(TelegramModule).get(DATABASE_POOL);
  const v1Pool = module.select(V1Module).get(DATABASE_POOL);

  expect(telegramPool).toBe(rootPool);
  expect(v1Pool).toBe(rootPool);
});
