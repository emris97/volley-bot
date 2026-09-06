import { AuthorizationDeniedError } from '@volley/application';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { registerAttendanceHandlers } from '../attendance/attendance.handlers.js';
import { registerPaymentHandlers } from '../payments/payment.handlers.js';

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

describe('privileged Telegram adapter boundaries', () => {
  it.each([
    ['attendance', registerAttendanceHandlers, 'at:any'],
    ['payment', registerPaymentHandlers, 'pay:any'],
  ] as const)(
    'acknowledges revoked organizer access for %s without failing the webhook',
    async (_name, register, data) => {
      const bot = new Bot('123456:abcdefghijklmnopqrstuvwxyz', { botInfo });
      const acknowledgements: unknown[] = [];
      bot.api.config.use(async (_previous, method, payload) => {
        if (method === 'answerCallbackQuery') acknowledgements.push(payload);
        return { ok: true, result: true } as never;
      });
      const handlers = {
        handleCallback: vi
          .fn()
          .mockRejectedValue(new AuthorizationDeniedError()),
      };
      register(bot, handlers as never);

      await expect(
        bot.handleUpdate(callbackUpdate(data)),
      ).resolves.toBeUndefined();
      expect(acknowledgements).toEqual([
        expect.objectContaining({
          text: 'Управление доступно только администраторам группы.',
          show_alert: true,
        }),
      ]);
    },
  );

  it.each([
    ['attendance', registerAttendanceHandlers],
    ['payment', registerPaymentHandlers],
  ] as const)(
    'returns a concise Russian reply when /%s is attempted after role revocation',
    async (command, register) => {
      const bot = new Bot('123456:abcdefghijklmnopqrstuvwxyz', { botInfo });
      const replies: unknown[] = [];
      bot.api.config.use(async (_previous, method, payload) => {
        if (method === 'sendMessage') replies.push(payload);
        return {
          ok: true,
          result: {
            message_id: 11,
            date: 1_700_000_000,
            chat: { id: 42, type: 'private' },
            text: 'ok',
          },
        } as never;
      });
      const handlers = {
        start: vi.fn().mockRejectedValue(new AuthorizationDeniedError()),
      };
      register(bot, handlers as never);

      await expect(
        bot.handleUpdate(commandUpdate(command)),
      ).resolves.toBeUndefined();
      expect(replies).toEqual([
        expect.objectContaining({
          text: 'Управление доступно только администраторам группы.',
        }),
      ]);
    },
  );
});

const commandUpdate = (command: string): Update =>
  ({
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 42, type: 'private', first_name: 'Admin' },
      from: { id: 42, is_bot: false, first_name: 'Admin' },
      text: `/${command} 018f6ba0-62d2-7bd1-8f13-12e0c8424601`,
      entities: [
        { offset: 0, length: command.length + 1, type: 'bot_command' },
      ],
    },
  }) as Update;

const callbackUpdate = (data: string): Update =>
  ({
    update_id: 1,
    callback_query: {
      id: 'callback-1',
      from: { id: 42, is_bot: false, first_name: 'Admin' },
      chat_instance: 'instance',
      data,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 42, type: 'private', first_name: 'Admin' },
        text: 'menu',
      },
    },
  }) as Update;
