import { describe, expect, it, vi } from 'vitest';
import { asGameId, asGroupId, asTelegramId } from '@volley/domain';
import type { GameMessageView } from './game-message.model.js';
import {
  GameMessageUpdater,
  TelegramMessageNotEditableError,
} from './game-message-updater.js';

describe('GameMessageUpdater', () => {
  it('creates and stores a replacement when Telegram cannot edit the old message', async () => {
    const current = view();
    const games = {
      load: vi.fn().mockResolvedValue(current),
      setCanonicalMessageId: vi.fn().mockResolvedValue(undefined),
    };
    const telegram = {
      editMessage: vi
        .fn()
        .mockRejectedValue(new TelegramMessageNotEditableError()),
      sendMessage: vi.fn().mockResolvedValue({ messageId: '9001' }),
      pinMessage: vi.fn().mockResolvedValue(undefined),
    };
    const updater = new GameMessageUpdater(games, telegram);

    await updater.refresh(current.groupId, current.gameId);

    expect(games.setCanonicalMessageId).toHaveBeenCalledWith(
      current.groupId,
      current.gameId,
      9001n,
    );
    expect(telegram.pinMessage).toHaveBeenCalledWith(
      current.telegramChatId,
      9001n,
    );
  });

  it('does not replace a message for unrelated Telegram failures', async () => {
    const current = view();
    const games = {
      load: vi.fn().mockResolvedValue(current),
      setCanonicalMessageId: vi.fn(),
    };
    const telegram = {
      editMessage: vi.fn().mockRejectedValue(new Error('network down')),
      sendMessage: vi.fn(),
    };
    const updater = new GameMessageUpdater(games, telegram);

    await expect(
      updater.refresh(current.groupId, current.gameId),
    ).rejects.toThrow('network down');
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the repository distributed lock when available', async () => {
    const current = view();
    const lockedRepository = {
      load: vi.fn().mockResolvedValue(current),
      setCanonicalMessageId: vi.fn(),
    };
    const games = {
      ...lockedRepository,
      withLockedView: vi
        .fn()
        .mockImplementation(async (_groupId, _gameId, callback) =>
          callback(lockedRepository),
        ),
    };
    const telegram = {
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
    };

    await new GameMessageUpdater(games, telegram).refresh(
      current.groupId,
      current.gameId,
    );

    expect(games.withLockedView).toHaveBeenCalledOnce();
    expect(lockedRepository.load).toHaveBeenCalledOnce();
  });

  it('persists a replacement before pinning and retries pinning the canonical message', async () => {
    const current = view();
    const games = {
      load: vi
        .fn()
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce({ ...current, canonicalMessageId: 9001n }),
      setCanonicalMessageId: vi.fn().mockResolvedValue(undefined),
    };
    const telegram = {
      editMessage: vi
        .fn()
        .mockRejectedValueOnce(new TelegramMessageNotEditableError())
        .mockResolvedValueOnce(undefined),
      sendMessage: vi.fn().mockResolvedValue({ messageId: 9001n }),
      pinMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('pin failed'))
        .mockResolvedValueOnce(undefined),
    };
    const updater = new GameMessageUpdater(games, telegram);

    await expect(
      updater.refresh(current.groupId, current.gameId),
    ).rejects.toThrow('pin failed');
    expect(games.setCanonicalMessageId).toHaveBeenCalledWith(
      current.groupId,
      current.gameId,
      9001n,
    );

    await updater.refresh(current.groupId, current.gameId);

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.pinMessage).toHaveBeenCalledTimes(2);
  });
});

const view = (): GameMessageView => ({
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
  telegramChatId: asTelegramId('-1001000000001'),
  canonicalMessageId: 99n,
  pinMessage: true,
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-04T16:00:00.000Z'),
  timeZone: 'Europe/Astrakhan',
  state: 'OPEN',
  capacity: 14,
  roster: [],
  waitlist: [],
  tentative: [],
});
