import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  asUserId,
} from '@volley/domain';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { expect, it } from 'vitest';
import { CallbackCodec } from '../callbacks/callback-codec.js';
import {
  RegistrationHandlers,
  registerRegistrationHandlers,
} from './registration.handlers.js';

it('registers the callback sender for the referenced game only', async () => {
  const codec = new CallbackCodec();
  const gameA = asGameId('123e4567-e89b-12d3-a456-426614174001');
  const gameB = asGameId('123e4567-e89b-12d3-a456-426614174002');
  const calls: unknown[] = [];
  const handlers = new RegistrationHandlers(
    codec,
    {
      resolve: async (gameId, telegramUserId) => ({
        groupId: asGroupId('group-a'),
        gameId,
        userId: asUserId(`user:${telegramUserId}`),
        activeRegistrationId: null,
      }),
    },
    {
      execute: async (command) => {
        calls.push(command);
        return {
          registrationId: asRegistrationId('registration-a'),
          state: 'ROSTERED',
          rosterPosition: 1,
        };
      },
    },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
  );

  const text = await handlers.handleCallback({
    telegramUserId: asTelegramId('42'),
    displayName: 'Игрок 42',
    updateId: 99,
    data: codec.going(gameA),
  });

  expect(text).toBe('Вы в составе. Место: 1.');
  expect(calls).toEqual([
    expect.objectContaining({
      gameId: gameA,
      idempotencyKey: 'callback:99',
      intent: 'CONFIRMED',
    }),
  ]);
  expect(calls).not.toEqual([expect.objectContaining({ gameId: gameB })]);
});

it('passes the Telegram display name to the identity resolver', async () => {
  const codec = new CallbackCodec();
  const gameId = asGameId('123e4567-e89b-12d3-a456-426614174001');
  const resolvedProfiles: unknown[] = [];
  const handlers = new RegistrationHandlers(
    codec,
    {
      resolve: async (resolvedGameId, telegramUserId, displayName) => {
        resolvedProfiles.push({
          gameId: resolvedGameId,
          telegramUserId,
          displayName,
        });
        return {
          groupId: asGroupId('group-a'),
          gameId: resolvedGameId,
          userId: asUserId(`user:${telegramUserId}`),
          activeRegistrationId: null,
        };
      },
    },
    {
      execute: async () => ({
        registrationId: asRegistrationId('registration-a'),
        state: 'TENTATIVE',
      }),
    },
    {
      execute: async () => ({
        registrationId: asRegistrationId('unused'),
        state: 'CANCELLED',
      }),
    },
  );

  await handlers.handleCallback({
    telegramUserId: asTelegramId('42'),
    displayName: 'Ада Лавлейс',
    updateId: 100,
    data: codec.tentative(gameId),
  });

  expect(resolvedProfiles).toEqual([
    {
      gameId,
      telegramUserId: asTelegramId('42'),
      displayName: 'Ада Лавлейс',
    },
  ]);
});

it('shows the resulting status as a visible Telegram alert', async () => {
  const bot = new Bot('123456:abcdefghijklmnopqrstuvwxyz', { botInfo });
  const acknowledgements: unknown[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'answerCallbackQuery') acknowledgements.push(payload);
    return { ok: true, result: true } as never;
  });
  const handlers = {
    handleCallback: async () => 'Вы в составе. Место: 1.',
  };
  registerRegistrationHandlers(bot, handlers as never);

  await bot.handleUpdate(callbackUpdate());

  expect(acknowledgements).toEqual([
    expect.objectContaining({
      text: 'Вы в составе. Место: 1.',
      show_alert: true,
    }),
  ]);
});

const botInfo: UserFromGetMe = {
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

const callbackUpdate = (): Update => ({
  update_id: 101,
  callback_query: {
    id: 'registration-callback',
    chat_instance: 'registration-chat',
    from: {
      id: 42,
      is_bot: false,
      first_name: 'Ада',
      last_name: 'Лавлейс',
    },
    data: 'v1:go:123e4567-e89b-12d3-a456-426614174001',
    message: {
      message_id: 7,
      date: 1_788_134_400,
      chat: { id: -1001, type: 'supergroup', title: 'Volley' },
    },
  },
});
