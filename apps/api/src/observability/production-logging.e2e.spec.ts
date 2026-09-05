import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { JsonLogger, type LogOutput } from '@volley/application';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  registerGroupOnboardingHandlers,
  StartTokenVerificationError,
  TELEGRAM_UPDATE_HANDLER,
  type TelegramUpdateHandler,
} from '@volley/telegram';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module.js';

type TelegramUpdate = Parameters<TelegramUpdateHandler['handleUpdate']>[0];

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

it('logs an expected onboarding rejection without exposing its token', async () => {
  const output: string[] = [];
  const invalidToken = 'invalid-onboarding-token-that-must-stay-private';
  const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', botInfo);
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: 1,
          date: 1_788_134_400,
          chat: { id: 81, type: 'private' },
          text: String((payload as Record<string, unknown>).text ?? ''),
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  registerGroupOnboardingHandlers(bot, {
    handleMyChatMember: vi.fn(),
    handleStart: vi
      .fn()
      .mockRejectedValue(new StartTokenVerificationError('INVALID')),
    handleCallback: vi.fn(),
  } as never);
  app = await createApp(output, createLazyTelegramUpdateHandler(bot));

  const response = await app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': 'telegram-invalid-start',
      'x-telegram-bot-api-secret-token': '0123456789abcdef',
    },
    payload: startUpdate(81, invalidToken),
  });

  expect(response.statusCode).toBe(200);
  expect(parsedLogs(output)).toContainEqual(
    expect.objectContaining({
      level: 'warn',
      message: 'Telegram onboarding input rejected',
      correlationId: 'telegram-invalid-start',
      updateId: '81',
      errorCategory: 'onboarding.invalid_link',
    }),
  );
  expect(output.join('\n')).not.toContain(invalidToken);
});

const createApp = async (
  output: string[],
  updateHandler: TelegramUpdateHandler = {
    handleUpdate: async () => undefined,
  },
): Promise<NestFastifyApplication> => {
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
    .useValue(updateHandler)
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

const startUpdate = (updateId: number, token: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat: { id: updateId, type: 'private', first_name: 'Admin' },
    from: { id: updateId, is_bot: false, first_name: 'Admin' },
    text: `/start ${token}`,
    entities: [{ offset: 0, length: 6, type: 'bot_command' }],
  },
});

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
