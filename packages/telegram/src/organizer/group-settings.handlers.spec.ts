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
});
