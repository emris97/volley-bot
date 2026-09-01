import { describe, expect, it, vi } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
} from '@volley/domain';
import { NotificationConsumer } from './notification.consumer.js';

describe('NotificationConsumer', () => {
  it('delivers a waitlist promotion to the promoted registration', async () => {
    const recipient = {
      registrationId: asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424620'),
      groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
      gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
      groupChatId: asTelegramId('-1001'),
      kind: 'MEMBER' as const,
      telegramUserId: asTelegramId('42'),
      inviterTelegramUserId: null,
      displayName: 'Игрок',
      confirmationRevision: 0,
    };
    const sender = { send: vi.fn() };
    const consumer = new NotificationConsumer(
      {
        listTentative: vi.fn(),
        listRostered: vi.fn(),
        findByRegistration: vi.fn().mockResolvedValue(recipient),
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ status: 'CLAIMED', claimToken: 'claim' }),
        markDelivered: vi.fn(),
        releaseDelivery: vi.fn(),
      },
      sender as never,
      { expireTentative: vi.fn() } as never,
    );

    await consumer.processWaitlistPromotion(recipient.registrationId);

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'WAITLIST_PROMOTED',
        text: 'Вы перешли из листа ожидания в основной состав',
      }),
    );
  });

  it('retries only recipients that were not durably delivered', async () => {
    const first = recipient('20');
    const second = recipient('21');
    const delivered = new Set<string>();
    const claimed = new Set<string>();
    const sender = {
      send: vi.fn().mockImplementation(async (intent) => {
        if (
          intent.recipient.telegramUserId === '21' &&
          sender.send.mock.calls.filter(
            ([value]) => value.recipient.telegramUserId === '21',
          ).length === 1
        ) {
          throw new Error('telegram unavailable');
        }
      }),
    };
    const recipients = {
      listTentative: vi.fn().mockResolvedValue([first, second]),
      listRostered: vi.fn(),
      findByRegistration: vi.fn(),
      claimDelivery: vi
        .fn()
        .mockImplementation(async (jobId, registrationId) => {
          const key = `${jobId}:${registrationId}`;
          if (delivered.has(key)) return { status: 'DELIVERED' };
          if (claimed.has(key)) return { status: 'BUSY' };
          claimed.add(key);
          return { status: 'CLAIMED', claimToken: key };
        }),
      markDelivered: vi
        .fn()
        .mockImplementation(async (jobId, registrationId) => {
          const key = `${jobId}:${registrationId}`;
          claimed.delete(key);
          delivered.add(key);
        }),
      releaseDelivery: vi
        .fn()
        .mockImplementation(async (jobId, registrationId) => {
          claimed.delete(`${jobId}:${registrationId}`);
        }),
    };
    const consumer = new NotificationConsumer(
      recipients,
      sender as never,
      { expireTentative: vi.fn() } as never,
    );
    const job = {
      id: 'REQUEST_TENTATIVE_CONFIRMATION:game:1',
      kind: 'REQUEST_TENTATIVE_CONFIRMATION' as const,
      groupId: first.groupId,
      gameId: first.gameId,
      scheduleRevision: 1,
      runAt: new Date(),
    };

    await expect(consumer.process(job)).rejects.toThrow('telegram unavailable');
    await consumer.process(job);

    expect(
      sender.send.mock.calls.filter(
        ([intent]) => intent.recipient.telegramUserId === '20',
      ),
    ).toHaveLength(1);
    expect(
      sender.send.mock.calls.filter(
        ([intent]) => intent.recipient.telegramUserId === '21',
      ),
    ).toHaveLength(2);
  });

  it('retries a job while another worker holds the delivery lease', async () => {
    const current = recipient('22');
    const sender = { send: vi.fn() };
    const consumer = new NotificationConsumer(
      {
        listTentative: vi.fn().mockResolvedValue([current]),
        listRostered: vi.fn(),
        findByRegistration: vi.fn(),
        claimDelivery: vi.fn().mockResolvedValue({ status: 'BUSY' }),
        markDelivered: vi.fn(),
        releaseDelivery: vi.fn(),
      },
      sender as never,
      { expireTentative: vi.fn() } as never,
    );

    await expect(
      consumer.process({
        id: 'REQUEST_TENTATIVE_CONFIRMATION:game:1',
        kind: 'REQUEST_TENTATIVE_CONFIRMATION',
        groupId: current.groupId,
        gameId: current.gameId,
        scheduleRevision: 1,
        runAt: new Date(),
      }),
    ).rejects.toThrow(/already claimed/i);
    expect(sender.send).not.toHaveBeenCalled();
  });
});

const recipient = (telegramId: string) => ({
  registrationId: asRegistrationId(
    `018f6ba0-62d2-7bd1-8f13-12e0c84246${telegramId}`,
  ),
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
  groupChatId: asTelegramId('-1001'),
  kind: 'MEMBER' as const,
  telegramUserId: asTelegramId(telegramId),
  inviterTelegramUserId: null,
  displayName: `Игрок ${telegramId}`,
  confirmationRevision: 0,
});
