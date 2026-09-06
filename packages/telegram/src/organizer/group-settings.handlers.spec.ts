import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { asGroupId, asTelegramId, asUserId } from '@volley/domain';
import {
  GroupSettingsHandlers,
  registerGroupSettingsHandlers,
} from './group-settings.handlers.js';

const telegramUserId = asTelegramId('42');
const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');

const settings = {
  timeZone: 'Europe/Astrakhan',
  memberPriorityEnabled: true,
  tentativePromptMinutesBefore: 720,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  currency: 'RUB' as const,
  roundingMode: 'UP_10' as const,
  pinGameMessages: true,
};

const harness = () => {
  const organizerContext = {
    require: vi.fn().mockResolvedValue({
      groupId,
      userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424612'),
      telegramChatId: asTelegramId('-1001'),
      title: 'Волейбол',
      timeZone: settings.timeZone,
    }),
  };
  const groups = {
    getOnboardingSnapshot: vi.fn().mockResolvedValue({
      telegramChatId: asTelegramId('-1001'),
      onboardingState: 'CONFIGURED',
      progress: {},
      settings,
    }),
  };
  const configure = { execute: vi.fn().mockResolvedValue(true) };
  return {
    organizerContext,
    groups,
    configure,
    handlers: new GroupSettingsHandlers(organizerContext, groups, configure),
  };
};

describe('GroupSettingsHandlers', () => {
  it('registers the versioned settings callback boundary', () => {
    const bot = { callbackQuery: vi.fn().mockReturnThis() };

    registerGroupSettingsHandlers(bot as never, harness().handlers);

    expect(bot.callbackQuery).toHaveBeenCalledOnce();
    expect(bot.callbackQuery.mock.calls[0]?.[0]).toEqual(/^gs:v1:/);
  });

  it('shows every current group default after fresh live organizer resolution', async () => {
    const { handlers, organizerContext } = harness();

    const view = await handlers.open(telegramUserId);

    expect(organizerContext.require).toHaveBeenCalledWith(telegramUserId);
    expect(view.text).toContain('Europe/Astrakhan');
    expect(view.text).toContain('участники группы выше гостей');
    expect(view.text).toContain('за 12 часов');
    expect(view.text).toContain('1 час');
    expect(view.text).toContain('за 2 часа');
    expect(view.text).toContain('Вверх до 10 ₽');
    expect(view.text).toContain('Закреплять сообщения: да');
    expect(view.text).toContain('RUB');
  });

  it('does not configure until a single-field change is confirmed', async () => {
    const { handlers, configure } = harness();

    const preview = await handlers.handleCallback(
      telegramUserId,
      'gs:v1:set:mp.n',
    );

    expect(configure.execute).not.toHaveBeenCalled();
    expect(preview.text).toContain('в порядке записи');

    await handlers.handleCallback(telegramUserId, 'gs:v1:confirm:mp.n');

    expect(configure.execute).toHaveBeenCalledWith({
      groupId,
      actorTelegramId: telegramUserId,
      ...settings,
      memberPriorityEnabled: false,
    });
  });

  it('re-reads the complete snapshot and live-authorizes every mutation', async () => {
    const { handlers, organizerContext, groups, configure } = harness();

    await handlers.handleCallback(telegramUserId, 'gs:v1:confirm:pin.n');

    expect(organizerContext.require).toHaveBeenCalledTimes(1);
    expect(groups.getOnboardingSnapshot).toHaveBeenCalledWith(groupId);
    expect(configure.execute).toHaveBeenCalledWith({
      groupId,
      actorTelegramId: telegramUserId,
      ...settings,
      pinGameMessages: false,
    });
    expect(configure.execute.mock.calls[0]?.[0]).not.toHaveProperty(
      'expectedOnboardingProgress',
    );
  });

  it('does not configure or audit a replayed confirmation already reflected in storage', async () => {
    const { handlers, configure } = harness();

    const view = await handlers.handleCallback(
      telegramUserId,
      'gs:v1:confirm:mp.y',
    );

    expect(configure.execute).not.toHaveBeenCalled();
    expect(view.text).toContain('Настройки уже актуальны');
  });

  it('acknowledges a replay even when Telegram reports that the message is not modified', async () => {
    const { handlers, configure } = harness();
    const bot = new Bot('123456:abcdefghijklmnopqrstuvwxyz', { botInfo });
    const methods: string[] = [];
    bot.api.config.use(async (_previous, method) => {
      methods.push(method);
      if (method === 'editMessageText') {
        return {
          ok: false,
          error_code: 400,
          description: 'Bad Request: message is not modified',
        } as never;
      }
      return { ok: true, result: true } as never;
    });
    registerGroupSettingsHandlers(bot, handlers);

    await expect(
      bot.handleUpdate(settingsCallbackUpdate()),
    ).resolves.toBeUndefined();
    expect(configure.execute).not.toHaveBeenCalled();
    expect(methods).toContain('answerCallbackQuery');
  });
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

const settingsCallbackUpdate = (): Update =>
  ({
    update_id: 1,
    callback_query: {
      id: 'callback-1',
      from: { id: 42, is_bot: false, first_name: 'Admin' },
      chat_instance: 'instance',
      data: 'gs:v1:confirm:mp.y',
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 42, type: 'private', first_name: 'Admin' },
        text: 'Настройки уже актуальны.',
      },
    },
  }) as Update;
