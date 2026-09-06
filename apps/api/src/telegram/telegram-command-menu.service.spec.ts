import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_COMMANDS } from '@volley/telegram';
import { TelegramCommandMenuService } from './telegram-command-menu.service.js';

describe('TelegramCommandMenuService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries private command installation after 1 and 2 seconds without blocking bootstrap', async () => {
    const api = {
      setMyCommands: vi
        .fn()
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValue(true),
      deleteMyCommands: vi.fn().mockResolvedValue(true),
    };
    const service = new TelegramCommandMenuService(api, { warn: vi.fn() });

    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(api.setMyCommands).toHaveBeenCalledTimes(3);
    expect(api.setMyCommands).toHaveBeenNthCalledWith(3, PRIVATE_COMMANDS, {
      scope: { type: 'all_private_chats' },
      language_code: 'ru',
    });
    expect(api.deleteMyCommands).toHaveBeenCalledWith({
      scope: { type: 'all_group_chats' },
      language_code: 'ru',
    });
    expect(api.deleteMyCommands).toHaveBeenCalledWith({
      scope: { type: 'all_chat_administrators' },
      language_code: 'ru',
    });
  });

  it('uses capped retry delays and cancels a pending retry on shutdown', async () => {
    const api = {
      setMyCommands: vi.fn().mockRejectedValue(new Error('timeout')),
      deleteMyCommands: vi.fn(),
    };
    const service = new TelegramCommandMenuService(api, { warn: vi.fn() });

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(
      1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 60_000,
    );
    expect(api.setMyCommands).toHaveBeenCalledTimes(8);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.setMyCommands).toHaveBeenCalledTimes(9);

    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(api.setMyCommands).toHaveBeenCalledTimes(9);
  });

  it('logs only the attempt and a stable error category', async () => {
    const api = {
      setMyCommands: vi.fn().mockRejectedValue({ error_code: 429 }),
      deleteMyCommands: vi.fn(),
    };
    const logger = { warn: vi.fn() };
    const service = new TelegramCommandMenuService(api, logger);

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith('Telegram command menu retry', {
      attempt: 1,
      errorCategory: 'rate_limit',
    });
  });

  it('does not schedule a retry when shutdown happens during an attempt', async () => {
    let rejectAttempt!: (error: unknown) => void;
    const api = {
      setMyCommands: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectAttempt = reject;
          }),
      ),
      deleteMyCommands: vi.fn(),
    };
    const service = new TelegramCommandMenuService(api, { warn: vi.fn() });

    service.onApplicationBootstrap();
    service.onApplicationShutdown();
    rejectAttempt(new Error('network unavailable'));
    await vi.advanceTimersByTimeAsync(0);

    expect(api.setMyCommands).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
