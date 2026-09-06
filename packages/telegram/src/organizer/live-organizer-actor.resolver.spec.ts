import { AuthorizationDeniedError } from '@volley/application';
import { asGameId, asGroupId, asTelegramId, asUserId } from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { AttendanceHandlers } from '../attendance/attendance.handlers.js';
import { PaymentHandlers } from '../payments/payment.handlers.js';
import { LiveOrganizerGameActorResolver } from './live-organizer-actor.resolver.js';

const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424601');
const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424602');
const telegramChatId = asTelegramId('-1005000');
const telegramUserId = asTelegramId('42');
const userId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424603');

describe('LiveOrganizerGameActorResolver', () => {
  it('checks Telegram and refreshes membership before every mutation resolution', async () => {
    const telegram = {
      getChatMember: vi
        .fn()
        .mockResolvedValueOnce({ status: 'administrator' as const })
        .mockResolvedValueOnce({ status: 'creator' as const }),
    };
    const directory = {
      resolveGameGroup: vi.fn().mockResolvedValue({ groupId, telegramChatId }),
      refreshMembership: vi.fn().mockResolvedValue(userId),
    };
    const resolver = new LiveOrganizerGameActorResolver(telegram, directory);

    await expect(resolver.resolve(gameId, telegramUserId)).resolves.toEqual({
      groupId,
      gameId,
      userId,
    });
    await expect(resolver.resolve(gameId, telegramUserId)).resolves.toEqual({
      groupId,
      gameId,
      userId,
    });

    expect(telegram.getChatMember).toHaveBeenCalledTimes(2);
    expect(directory.refreshMembership).toHaveBeenNthCalledWith(1, {
      groupId,
      telegramUserId,
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(directory.refreshMembership).toHaveBeenNthCalledWith(2, {
      groupId,
      telegramUserId,
      role: 'OWNER',
      status: 'ACTIVE',
    });
  });

  it('refreshes a revoked administrator as an active member and denies the mutation', async () => {
    const telegram = {
      getChatMember: vi.fn().mockResolvedValue({ status: 'member' as const }),
    };
    const directory = {
      resolveGameGroup: vi.fn().mockResolvedValue({ groupId, telegramChatId }),
      refreshMembership: vi.fn().mockResolvedValue(userId),
    };
    const resolver = new LiveOrganizerGameActorResolver(telegram, directory);

    await expect(
      resolver.resolve(gameId, telegramUserId),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(directory.refreshMembership).toHaveBeenCalledWith({
      groupId,
      telegramUserId,
      role: 'MEMBER',
      status: 'ACTIVE',
    });
  });

  it.each(['left', 'kicked'] as const)(
    'persists Telegram %s as LEFT while denying organizer access',
    async (status) => {
      const directory = {
        resolveGameGroup: vi
          .fn()
          .mockResolvedValue({ groupId, telegramChatId }),
        refreshMembership: vi.fn().mockResolvedValue(userId),
      };
      const resolver = new LiveOrganizerGameActorResolver(
        { getChatMember: vi.fn().mockResolvedValue({ status }) },
        directory,
      );

      await expect(
        resolver.resolve(gameId, telegramUserId),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      expect(directory.refreshMembership).toHaveBeenCalledWith({
        groupId,
        telegramUserId,
        role: 'MEMBER',
        status: 'LEFT',
      });
    },
  );

  it('freshly authorizes each attendance and payment mutation entry', async () => {
    const telegram = {
      getChatMember: vi.fn().mockResolvedValue({
        status: 'administrator' as const,
      }),
    };
    const directory = {
      resolveGameGroup: vi.fn().mockResolvedValue({ groupId, telegramChatId }),
      refreshMembership: vi.fn().mockResolvedValue(userId),
    };
    const resolver = new LiveOrganizerGameActorResolver(telegram, directory);
    const confirmAttendance = { execute: vi.fn().mockResolvedValue({}) };
    const attendance = new AttendanceHandlers(
      resolver,
      confirmAttendance as never,
      {} as never,
    );
    await attendance.preview({
      telegramUserId,
      gameId,
      expectedRevision: 1,
      excludedRegistrationIds: [],
      manualParticipants: [],
    });
    await attendance.finalize({
      telegramUserId,
      gameId,
      expectedRevision: 2,
      excludedRegistrationIds: [],
      manualParticipants: [],
    });

    const finalizeSettlement = {
      execute: vi.fn().mockResolvedValue({ revision: 1, charges: [] }),
    };
    const changeChargeStatus = { execute: vi.fn().mockResolvedValue({}) };
    const sendPaymentReminders = {
      execute: vi.fn().mockResolvedValue({ enqueued: 1 }),
    };
    const payments = new PaymentHandlers(
      resolver,
      {} as never,
      finalizeSettlement as never,
      changeChargeStatus as never,
      sendPaymentReminders as never,
      {} as never,
      {} as never,
    );
    await payments.confirm({
      telegramUserId,
      gameId,
      privateChat: true,
      attendanceRevision: 1,
      totalAmount: '1000',
      currency: 'RUB',
      roundingMode: 'EXACT',
    });
    await payments.changeStatus({
      telegramUserId,
      gameId,
      privateChat: true,
      chargeId: '018f6ba0-62d2-7bd1-8f13-12e0c8424604',
      status: 'PAID',
    });
    await payments.sendReminders({
      telegramUserId,
      gameId,
      privateChat: true,
      chargeIds: ['018f6ba0-62d2-7bd1-8f13-12e0c8424604'],
      idempotencyKey: 'update:1',
    });

    expect(telegram.getChatMember).toHaveBeenCalledTimes(5);
    expect(directory.refreshMembership).toHaveBeenCalledTimes(5);
    expect(confirmAttendance.execute).toHaveBeenCalledTimes(2);
    expect(finalizeSettlement.execute).toHaveBeenCalledOnce();
    expect(changeChargeStatus.execute).toHaveBeenCalledOnce();
    expect(sendPaymentReminders.execute).toHaveBeenCalledOnce();
  });
});
