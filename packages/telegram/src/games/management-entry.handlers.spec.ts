import { describe, expect, it, vi } from 'vitest';
import { AuthorizationDeniedError } from '@volley/application';
import { asGameId, asGroupId, asTelegramId, asUserId } from '@volley/domain';
import { ManagementEntryHandlers } from './management-entry.handlers.js';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
} from '../bot.factory.js';
import { registerManagementEntryHandlers } from './management-entry.handlers.js';

const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const userId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424612');
const telegramUserId = asTelegramId('42');

describe('ManagementEntryHandlers', () => {
  it('builds state-appropriate private actions for an authorized organizer', async () => {
    const handlers = handlersFor({ dmAvailable: true, finalized: true });

    const menu = await handlers.open({
      gameId,
      telegramUserId,
      privateChat: false,
    });

    expect(menu).toMatchObject({
      gameId,
      text: 'Управление игрой',
      buttons: [
        { text: 'Посещаемость', action: 'attendance' },
        { text: 'Расчёт оплат', action: 'payment' },
      ],
    });
  });

  it('returns the same non-sensitive unavailable result for unauthorized and unlinked group users', async () => {
    const unauthorized = handlersFor(
      { dmAvailable: true, finalized: true },
      true,
    );
    const unlinked = handlersFor({ dmAvailable: false, finalized: true });

    await expect(
      unauthorized.open({ gameId, telegramUserId, privateChat: false }),
    ).resolves.toBeNull();
    await expect(
      unlinked.open({ gameId, telegramUserId, privateChat: false }),
    ).resolves.toBeNull();
  });

  it('does not expose payment actions before attendance is finalized', async () => {
    const handlers = handlersFor({ dmAvailable: true, finalized: false });

    const menu = await handlers.open({
      gameId,
      telegramUserId,
      privateChat: true,
    });

    expect(menu?.buttons).toEqual([
      { text: 'Посещаемость', action: 'attendance' },
    ]);
  });

  it('answers an unlinked group MANAGE callback generically without sending game data', async () => {
    const apiCalls: Array<{
      method: string;
      payload: Record<string, unknown>;
    }> = [];
    const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', {
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
    });
    bot.api.config.use(async (_previous, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: true } as never;
    });
    registerManagementEntryHandlers(
      bot,
      handlersFor({ dmAvailable: false, finalized: true }),
      { start: vi.fn() } as never,
      { start: vi.fn() } as never,
    );

    await createLazyTelegramUpdateHandler(bot).handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'manage-1',
        chat_instance: 'manage',
        from: { id: 42, is_bot: false, first_name: 'Ada' },
        data: `v1:manage:${gameId}`,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -1001, type: 'supergroup', title: 'Group' },
          text: 'game',
        },
      },
    } as never);

    expect(apiCalls).toEqual([
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: expect.objectContaining({
          text: 'management:check-private-chat',
        }),
      }),
    ]);
    expect(JSON.stringify(apiCalls)).not.toContain('Управление игрой');
  });

  it('does not mark a linked private recipient unavailable on a transient Telegram failure', async () => {
    const markPrivateUnavailable = vi.fn();
    const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', {
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
    });
    bot.api.config.use(async (_previous, method) => {
      if (method === 'sendMessage')
        throw new Error('temporary network failure');
      return { ok: true, result: true } as never;
    });
    registerManagementEntryHandlers(
      bot,
      handlersFor(
        { dmAvailable: true, finalized: true },
        false,
        markPrivateUnavailable,
      ),
      { start: vi.fn() } as never,
      { start: vi.fn() } as never,
    );

    await expect(
      createLazyTelegramUpdateHandler(bot).handleUpdate({
        update_id: 2,
        callback_query: {
          id: 'manage-2',
          chat_instance: 'manage',
          from: { id: 42, is_bot: false, first_name: 'Ada' },
          data: `v1:manage:${gameId}`,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: -1001, type: 'supergroup', title: 'Group' },
            text: 'game',
          },
        },
      } as never),
    ).rejects.toThrow('temporary network failure');
    expect(markPrivateUnavailable).not.toHaveBeenCalled();
  });
});

const handlersFor = (
  state: { dmAvailable: boolean; finalized: boolean },
  denied = false,
  markPrivateUnavailable = vi.fn(),
) =>
  new ManagementEntryHandlers(
    {
      resolve: vi.fn().mockResolvedValue({
        groupId,
        gameId,
        userId,
        gameState: 'COMPLETED',
        dmAvailable: state.dmAvailable,
        hasFinalizedAttendance: state.finalized,
      }),
      markPrivateUnavailable,
    },
    {
      requireOrganizer: vi.fn().mockImplementation(async () => {
        if (denied) throw new AuthorizationDeniedError();
      }),
    },
  );
