import { describe, expect, it, vi } from 'vitest';
import { asGameId, asGroupId, asTelegramId } from '@volley/domain';
import {
  NotificationSender,
  TelegramPrivateChatUnavailableError,
} from './notification.sender.js';

describe('NotificationSender', () => {
  it('falls back to a group mention when private delivery is forbidden', async () => {
    const telegram = {
      sendPrivate: vi
        .fn()
        .mockRejectedValue(new TelegramPrivateChatUnavailableError()),
      sendGroupMessage: vi.fn().mockResolvedValue(undefined),
    };
    const availability = {
      markUnavailable: vi.fn().mockResolvedValue(undefined),
    };
    const sender = new NotificationSender(telegram, availability);

    await sender.send(intent());

    expect(availability.markUnavailable).toHaveBeenCalledWith(
      asTelegramId('42'),
    );
    expect(telegram.sendGroupMessage).toHaveBeenCalledWith(
      asTelegramId('-1001'),
      expect.stringContaining('tg://user?id=42'),
    );
  });

  it('routes guest notifications through the inviter', async () => {
    const telegram = {
      sendPrivate: vi.fn().mockResolvedValue(undefined),
      sendGroupMessage: vi.fn(),
    };
    const sender = new NotificationSender(telegram, {
      markUnavailable: vi.fn(),
    });

    await sender.send(
      intent({
        recipient: {
          kind: 'GUEST',
          telegramUserId: null,
          inviterTelegramUserId: asTelegramId('77'),
          displayName: 'Гость Анна',
        },
      }),
    );

    expect(telegram.sendPrivate).toHaveBeenCalledWith(
      asTelegramId('77'),
      expect.stringContaining('Гость Анна'),
      expect.any(Array),
    );
  });
});

const intent = (overrides = {}) => ({
  notificationType: 'TENTATIVE_CONFIRMATION' as const,
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
  groupChatId: asTelegramId('-1001'),
  recipient: {
    kind: 'MEMBER' as const,
    telegramUserId: asTelegramId('42'),
    inviterTelegramUserId: null,
    displayName: 'Иван',
  },
  text: 'Подтвердите участие',
  buttons: ['Подтверждаю', 'Снимаюсь'],
  ...overrides,
});
