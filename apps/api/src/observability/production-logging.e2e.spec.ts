import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { JsonLogger, type LogOutput } from '@volley/application';
import { TELEGRAM_UPDATE_HANDLER } from '@volley/telegram';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';

let app: NestFastifyApplication | undefined;
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
  await app?.close();
  app = undefined;
  process.env = previousEnv;
});

it('logs API request correlation through the production AppModule path', async () => {
  const output: string[] = [];
  app = await createApp(output);

  const response = await app.inject({
    method: 'GET',
    url: '/health/live',
    headers: { 'x-correlation-id': 'api-correlation-42' },
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['x-correlation-id']).toBe('api-correlation-42');
  expect(parsedLogs(output)).toContainEqual(
    expect.objectContaining({
      level: 'info',
      message: 'HTTP request completed',
      correlationId: 'api-correlation-42',
      method: 'GET',
      path: '/health/live',
      statusCode: 200,
    }),
  );
});

it('logs Telegram update and group correlation through the production webhook', async () => {
  const output: string[] = [];
  app = await createApp(output);
  const update = {
    update_id: 73,
    my_chat_member: {
      chat: {
        id: -1000000000073,
        type: 'supergroup',
        title: 'Observability group',
      },
      from: { id: 73, is_bot: false, first_name: 'Ada' },
      date: 1_788_134_400,
      old_chat_member: {
        user: botInfo,
        status: 'member',
      },
      new_chat_member: {
        user: botInfo,
        status: 'left',
      },
    },
  };

  const response = await app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': 'telegram-correlation-73',
      'x-telegram-bot-api-secret-token': '0123456789abcdef',
    },
    payload: update,
  });

  expect(response.statusCode).toBe(200);
  expect(parsedLogs(output)).toContainEqual(
    expect.objectContaining({
      level: 'info',
      message: 'Telegram update handled',
      correlationId: 'telegram-correlation-73',
      updateId: '73',
      groupId: '-1000000000073',
    }),
  );
});

const createApp = async (output: string[]): Promise<NestFastifyApplication> => {
  const logger = new JsonLogger({
    level: 'info',
    output: (line: LogOutput) => output.push(line),
    secrets: [
      process.env.BOT_TOKEN!,
      process.env.TELEGRAM_WEBHOOK_SECRET!,
      process.env.DATABASE_URL!,
      process.env.REDIS_URL!,
    ],
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TELEGRAM_UPDATE_HANDLER)
    .useValue({ handleUpdate: async () => undefined })
    .compile();
  const current = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger },
  );
  await current.init();
  await current.getHttpAdapter().getInstance().ready();
  return current;
};

const parsedLogs = (output: readonly string[]): Record<string, unknown>[] =>
  output.map((line) => JSON.parse(line) as Record<string, unknown>);

const botInfo = {
  id: 999,
  is_bot: true as const,
  first_name: 'Volley',
  username: 'volley_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
