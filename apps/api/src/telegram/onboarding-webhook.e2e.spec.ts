import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  OnboardingInputError,
  registerGroupOnboardingHandlers,
  StartTokenVerificationError,
  TELEGRAM_UPDATE_HANDLER,
  TELEGRAM_WEBHOOK_SECRET,
  WebhookController,
  type TelegramUpdateHandler,
} from '@volley/telegram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TelegramUpdate = Parameters<TelegramUpdateHandler['handleUpdate']>[0];

describe('onboarding webhook HTTP behavior', () => {
  let app: NestFastifyApplication;
  let calls: Array<{ method: string; payload: Record<string, unknown> }>;
  let handlers: ReturnType<typeof handlerStubs>;

  beforeEach(async () => {
    calls = [];
    handlers = handlerStubs();
    const bot = createTelegramBot(
      '123456:abcdefghijklmnopqrstuvwxyz',
      botInfo as never,
    );
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === 'answerCallbackQuery') {
        return { ok: true, result: true } as never;
      }
      return {
        ok: true,
        result: {
          message_id: calls.length,
          date: 1_788_134_400,
          chat: { id: 42, type: 'private' },
          text: String((payload as Record<string, unknown>).text ?? ''),
        },
      } as never;
    });
    registerGroupOnboardingHandlers(bot, handlers as never);

    const module = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        {
          provide: TELEGRAM_UPDATE_HANDLER,
          useValue: createLazyTelegramUpdateHandler(bot),
        },
        { provide: TELEGRAM_WEBHOOK_SECRET, useValue: webhookSecret },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 for bare start and still handles the next valid update', async () => {
    const bare = await post(startUpdate(1, ''));
    const valid = await post(startUpdate(2, 'valid-token'));

    expect([bare.statusCode, valid.statusCode]).toEqual([200, 200]);
    expect(handlers.handleStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid token', new StartTokenVerificationError('INVALID')],
    ['expired token', new StartTokenVerificationError('EXPIRED')],
    ['foreign link', new OnboardingInputError('FOREIGN_LINK')],
  ])('returns 200 for an expected %s failure', async (_label, error) => {
    handlers.handleStart.mockRejectedValueOnce(error);

    const response = await post(startUpdate(3, 'rejected-token'));

    expect(response.statusCode).toBe(200);
  });

  it('returns 200 and acknowledges a stale callback exactly once', async () => {
    handlers.handleCallback.mockResolvedValueOnce({
      notice: 'Показываю текущий шаг',
    });

    const response = await post(callbackUpdate(4));

    expect(response.statusCode).toBe(200);
    expect(
      calls.filter(({ method }) => method === 'answerCallbackQuery'),
    ).toHaveLength(1);
  });

  it('returns 500 for an unknown handler failure', async () => {
    handlers.handleStart.mockRejectedValueOnce(
      new Error('postgres unavailable'),
    );

    const response = await post(startUpdate(5, 'valid-token'));

    expect(response.statusCode).toBe(500);
  });

  const post = (payload: TelegramUpdate) =>
    app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': webhookSecret,
      },
      payload,
    });
});

const handlerStubs = () => ({
  handleMyChatMember: vi.fn().mockResolvedValue(undefined),
  handleStart: vi.fn().mockResolvedValue(true),
  handleCallback: vi.fn().mockResolvedValue({}),
});

const startUpdate = (updateId: number, token: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat: { id: 42, type: 'private', first_name: 'Admin' },
    from: { id: 42, is_bot: false, first_name: 'Admin' },
    text: token.length === 0 ? '/start' : `/start ${token}`,
    entities: [{ offset: 0, length: 6, type: 'bot_command' }],
  },
});

const callbackUpdate = (updateId: number): TelegramUpdate => ({
  update_id: updateId,
  callback_query: {
    id: `callback-${updateId}`,
    chat_instance: 'test',
    from: { id: 42, is_bot: false, first_name: 'Admin' },
    data: 'cfg:00000000-0000-4000-8000-000000000001:mp:1',
    message: {
      message_id: 500,
      date: 1_788_134_400,
      chat: { id: 42, type: 'private', first_name: 'Admin' },
      text: 'configuration',
    },
  },
});

const webhookSecret = '0123456789abcdef';

const botInfo = {
  id: 999,
  is_bot: true,
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
