import { describe, expect, it, vi } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  asUserId,
} from '@volley/domain';
import { TentativeHandlers, tentativeCallback } from './tentative.handlers.js';

describe('TentativeHandlers', () => {
  it.each([
    ['confirm' as const, 'confirm'],
    ['withdraw' as const, 'withdraw'],
  ])('passes callback revision to %s transition', async (action, target) => {
    const registrationId = asRegistrationId(
      '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
    );
    const confirm = { execute: vi.fn() };
    const withdraw = { execute: vi.fn() };
    const handlers = new TentativeHandlers(
      {
        resolve: vi.fn().mockResolvedValue({
          groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
          gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
          userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424630'),
        }),
      },
      confirm as never,
      withdraw as never,
    );

    await handlers.handle({
      telegramUserId: asTelegramId('42'),
      data: tentativeCallback(registrationId, 7, action),
    });

    const selected = target === 'confirm' ? confirm.execute : withdraw.execute;
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConfirmationRevision: 7 }),
    );
  });
});
