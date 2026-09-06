import { describe, expect, it, vi } from 'vitest';
import { asTelegramId } from '@volley/domain';
import type { Update, UserFromGetMe } from 'grammy/types';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  GrammyTelegramGateway,
  registerGroupOnboardingHandlers,
} from './bot.factory.js';
import { OnboardingInputError } from './group-onboarding.model.js';

describe('GrammyTelegramGateway', () => {
  it('treats an unchanged edit as an idempotent success', async () => {
    const bot = {
      api: {
        editMessageText: vi
          .fn()
          .mockRejectedValue(new Error('Bad Request: message is not modified')),
      },
    };
    const gateway = new GrammyTelegramGateway(bot as never);

    await expect(
      gateway.editMessage(asTelegramId('-1001'), 42n, 'same text'),
    ).resolves.toBeUndefined();
  });
});

describe('group onboarding grammY adapter', () => {
  it('opens the private organizer home for bare start without invoking token verification', async () => {
    const harness = createBotHarness({ includeBareStart: true });

    await expect(
      harness.updates.handleUpdate(startUpdate(1, '')),
    ).resolves.toBeUndefined();

    expect(harness.handlers.handleStart).not.toHaveBeenCalled();
    expect(harness.bareStart.openHome).toHaveBeenCalledWith(asTelegramId('42'));
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        method: 'sendMessage',
        payload: expect.objectContaining({ text: 'organizer:home' }),
      }),
    );
  });

  it('keeps signed start routing onboarding first and then guest handling', async () => {
    const harness = createBotHarness({ onboardingHandled: false });

    await harness.updates.handleUpdate(startUpdate(2, 'guest-token'));

    expect(harness.handlers.handleStart).toHaveBeenCalledBefore(
      harness.guestHandlers.handleStart,
    );
    expect(harness.guestHandlers.handleStart).toHaveBeenCalledOnce();
  });

  it('does not render organizer controls for bare start in a group', async () => {
    const harness = createBotHarness({ includeBareStart: true });

    await harness.updates.handleUpdate(groupStartUpdate(3));

    expect(harness.bareStart.openHome).not.toHaveBeenCalled();
  });

  it('maps expected start failures to a successful update', async () => {
    const harness = createBotHarness();
    harness.handlers.handleStart.mockRejectedValueOnce(
      new OnboardingInputError('FOREIGN_LINK'),
    );

    await expect(
      harness.updates.handleUpdate(startUpdate(2, 'valid-token')),
    ).resolves.toBeUndefined();

    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        method: 'sendMessage',
        payload: expect.objectContaining({
          text: expect.stringContaining('другого администратора'),
        }),
      }),
    );
  });

  it('acknowledges a stale callback exactly once', async () => {
    const harness = createBotHarness();
    harness.handlers.handleCallback.mockResolvedValueOnce({
      notice: 'Показываю текущий шаг',
    });

    await harness.updates.handleUpdate(callbackUpdate(3));

    expect(
      harness.calls.filter(({ method }) => method === 'answerCallbackQuery'),
    ).toHaveLength(1);
    expect(harness.handlers.handleCallback).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 500n }),
    );
  });

  it('acknowledges expected callback rejection without throwing', async () => {
    const harness = createBotHarness();
    harness.handlers.handleCallback.mockRejectedValueOnce(
      new OnboardingInputError('ADMIN_REQUIRED'),
    );

    await expect(
      harness.updates.handleUpdate(callbackUpdate(4)),
    ).resolves.toBeUndefined();

    expect(
      harness.calls.filter(({ method }) => method === 'answerCallbackQuery'),
    ).toHaveLength(1);
  });

  it('acknowledges then rethrows unknown callback failures', async () => {
    const harness = createBotHarness();
    harness.handlers.handleCallback.mockRejectedValueOnce(
      new Error('postgres unavailable'),
    );

    await expect(
      harness.updates.handleUpdate(callbackUpdate(5)),
    ).rejects.toThrow('postgres unavailable');
    expect(
      harness.calls.filter(({ method }) => method === 'answerCallbackQuery'),
    ).toHaveLength(1);
  });

  it('preserves valid guest start routing', async () => {
    const harness = createBotHarness({ onboardingHandled: false });

    await harness.updates.handleUpdate(startUpdate(6, 'guest-token'));

    expect(harness.guestHandlers.handleStart).toHaveBeenCalledOnce();
    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        method: 'sendMessage',
        payload: expect.objectContaining({ text: 'guest:name' }),
      }),
    );
  });

  it('passes idle guest text to handlers registered later in the runtime', async () => {
    const harness = createBotHarness({ includeDownstreamText: true });

    await harness.updates.handleUpdate(textUpdate(8, 'обычный текст'));

    expect(harness.guestHandlers.handleName).toHaveBeenCalledOnce();
    expect(harness.downstreamText).toHaveBeenCalledOnce();
  });

  it('answers an unsupported start purpose when no private flow owns it', async () => {
    const harness = createBotHarness({
      onboardingHandled: false,
      includeGuestHandlers: false,
    });

    await expect(
      harness.updates.handleUpdate(startUpdate(7, 'unsupported-token')),
    ).resolves.toBeUndefined();

    expect(harness.calls).toContainEqual(
      expect.objectContaining({
        method: 'sendMessage',
        payload: expect.objectContaining({
          text: expect.stringContaining('не подходит'),
        }),
      }),
    );
  });
});

const createBotHarness = (options?: {
  onboardingHandled?: boolean;
  includeGuestHandlers?: boolean;
  includeBareStart?: boolean;
  includeDownstreamText?: boolean;
}) => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const handlers = {
    handleMyChatMember: vi.fn(),
    handleStart: vi.fn().mockResolvedValue(options?.onboardingHandled ?? true),
    handleCallback: vi.fn().mockResolvedValue({}),
  };
  const guestHandlers = {
    handleStart: vi.fn().mockResolvedValue(undefined),
    handleName: vi.fn().mockResolvedValue(false),
  };
  const bareStart = {
    openHome: vi.fn().mockResolvedValue({
      text: 'organizer:home',
      parseMode: 'HTML',
      keyboard: [],
    }),
  };
  const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', botInfo);
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'answerCallbackQuery')
      return { ok: true, result: true } as never;
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
  registerGroupOnboardingHandlers(
    bot,
    handlers as never,
    options?.includeGuestHandlers === false
      ? undefined
      : (guestHandlers as never),
    options?.includeBareStart === true ? (bareStart as never) : undefined,
  );
  const downstreamText = vi.fn();
  if (options?.includeDownstreamText === true) {
    bot.on('message:text', downstreamText);
  }
  return {
    calls,
    handlers,
    guestHandlers,
    bareStart,
    downstreamText,
    updates: createLazyTelegramUpdateHandler(bot),
  };
};

const textUpdate = (updateId: number, text: string): Update => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat: { id: 42, type: 'private', first_name: 'Admin' },
    from: { id: 42, is_bot: false, first_name: 'Admin' },
    text,
  },
});

const startUpdate = (updateId: number, token: string): Update => ({
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

const groupStartUpdate = (updateId: number): Update => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat: { id: -1001, type: 'supergroup', title: 'Group' },
    from: { id: 42, is_bot: false, first_name: 'Admin' },
    text: '/start',
    entities: [{ offset: 0, length: 6, type: 'bot_command' }],
  },
});

const callbackUpdate = (updateId: number): Update => ({
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
