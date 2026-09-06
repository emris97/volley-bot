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
  it('uses strict canonical base36 revisions in generated and accepted callbacks', async () => {
    const registrationId = asRegistrationId(
      '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
    );
    const resolve = vi.fn();
    const handlers = new TentativeHandlers(
      { resolve },
      { execute: vi.fn() } as never,
      { execute: vi.fn() } as never,
    );
    const canonical = tentativeCallback(registrationId, 35, 'confirm');
    expect(canonical).toContain(':z:');

    for (const malformed of [
      canonical.replace(':z:', ':00:'),
      canonical.replace(':z:', ':Z:'),
      canonical.replace(':z:', ':z!:'),
      canonical.replace(':z:', ':zik0zk:'),
      canonical.replace(String(registrationId), ''),
      canonical.replace(String(registrationId), 'not-a-uuid'),
      canonical.replace(
        String(registrationId),
        String(registrationId).toUpperCase(),
      ),
      `${canonical}:extra`,
    ]) {
      await expect(
        handlers.handle({
          telegramUserId: asTelegramId('42'),
          data: malformed,
        }),
      ).rejects.toThrow('Invalid tentative callback');
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(() =>
      tentativeCallback(
        asRegistrationId(String(registrationId).toUpperCase()),
        35,
        'confirm',
      ),
    ).toThrow('Invalid tentative callback registration id');
    for (const invalid of [-1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        tentativeCallback(registrationId, invalid, 'confirm'),
      ).toThrow('Invalid tentative callback revision');
    }
  });

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
