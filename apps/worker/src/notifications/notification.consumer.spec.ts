import { describe, expect, it, vi } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
} from '@volley/domain';
import { NotificationConsumer } from './notification.consumer.js';
import { MetricsRegistry } from '@volley/application';
import { NotificationSender } from '@volley/telegram';
import type { GameEventNotificationRecipientRecord } from '@volley/persistence';

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
        listActiveForGame: vi.fn(),
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
      listActiveForGame: vi.fn(),
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
        listActiveForGame: vi.fn(),
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

  it('records a terminal notification failure through the production consumer', async () => {
    const current = recipient('23');
    const metrics = new MetricsRegistry();
    const consumer = new NotificationConsumer(
      {
        listTentative: vi.fn().mockResolvedValue([current]),
        listRostered: vi.fn(),
        listActiveForGame: vi.fn(),
        findByRegistration: vi.fn(),
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ status: 'CLAIMED', claimToken: 'claim' }),
        markDelivered: vi.fn(),
        releaseDelivery: vi.fn(),
      },
      {
        send: vi.fn().mockRejectedValue(new Error('telegram unavailable')),
      } as never,
      { expireTentative: vi.fn() } as never,
      metrics,
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
    ).rejects.toThrow('telegram unavailable');

    expect(metrics.render()).toContain(
      'volley_notification_failures_total{channel="private"} 1',
    );
  });

  it('delivers one leased local-time notification for every active registration after a material edit', async () => {
    const first = gameRecipient('20');
    const second = gameRecipient('21');
    const recipients = repositoryDouble([first, second]);
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new NotificationConsumer(
      recipients,
      sender as never,
      { expireTentative: vi.fn() } as never,
    );

    await consumer.processGameEvent(
      'GAME_UPDATED',
      {
        aggregateType: 'GAME',
        aggregateId: first.gameId,
        groupId: first.groupId,
        materialFields: ['startsAt', 'venue'],
        startsAtBefore: '2026-09-10T15:00:00.000Z',
        startsAtAfter: '2026-09-11T16:00:00.000Z',
        venueBefore: 'Зал 1',
        venueAfter: 'Зал 2',
      },
      'outbox:event-id:notification',
    );

    expect(recipients.listActiveForGame).toHaveBeenCalledWith(
      first.groupId,
      first.gameId,
    );
    expect(recipients.claimDelivery).toHaveBeenNthCalledWith(
      1,
      'outbox:event-id:notification',
      first.registrationId,
    );
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'GAME_CHANGED',
        text:
          'Игра «Среда вечером» изменена:\n' +
          'Было: 10.09.2026, 19:00 — Зал 1\n' +
          'Стало: 11.09.2026, 20:00 — Зал 2',
      }),
    );
  });

  it('notifies a guest through the inviter and escapes game values before HTML delivery', async () => {
    const guest = {
      ...gameRecipient('20'),
      kind: 'GUEST' as const,
      telegramUserId: null,
      inviterTelegramUserId: asTelegramId('77'),
      displayName: '<Гость>',
      game: {
        ...gameRecipient('20').game,
        name: '<Среда & вечер>',
      },
    };
    const recipients = repositoryDouble([guest]);
    const telegram = {
      sendPrivate: vi.fn().mockResolvedValue(undefined),
      sendGroupMessage: vi.fn().mockResolvedValue(undefined),
    };
    const consumer = new NotificationConsumer(
      recipients,
      new NotificationSender(telegram, { markUnavailable: vi.fn() }),
      { expireTentative: vi.fn() } as never,
    );

    await consumer.processGameEvent(
      'GAME_STATE_CHANGED',
      {
        aggregateType: 'GAME',
        aggregateId: guest.gameId,
        groupId: guest.groupId,
        from: 'OPEN',
        to: 'CANCELLED',
      },
      'outbox:cancelled:notification',
    );

    expect(telegram.sendPrivate).toHaveBeenCalledWith(
      asTelegramId('77'),
      '&lt;Гость&gt;: Игра «&lt;Среда &amp; вечер&gt;» отменена.',
      [],
    );
  });

  it('does not send a delivered game-event notification again', async () => {
    const current = gameRecipient('24');
    const recipients = repositoryDouble([current]);
    recipients.claimDelivery.mockResolvedValue({ status: 'DELIVERED' });
    const sender = { send: vi.fn() };
    const consumer = new NotificationConsumer(
      recipients,
      sender as never,
      { expireTentative: vi.fn() } as never,
    );

    await consumer.processGameEvent(
      'GAME_STATE_CHANGED',
      {
        aggregateType: 'GAME',
        aggregateId: current.gameId,
        groupId: current.groupId,
        from: 'CLOSED',
        to: 'CANCELLED',
      },
      'outbox:cancelled:notification',
    );

    expect(sender.send).not.toHaveBeenCalled();
    expect(recipients.markDelivered).not.toHaveBeenCalled();
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

const gameRecipient = (telegramId: string) => ({
  ...recipient(telegramId),
  game: {
    name: 'Среда вечером',
    venue: 'Зал 2',
    address: null,
    startsAt: new Date('2026-09-11T16:00:00.000Z'),
    timeZone: 'Europe/Astrakhan',
  },
});

const repositoryDouble = (
  active: readonly GameEventNotificationRecipientRecord[],
) => ({
  listTentative: vi.fn(),
  listRostered: vi.fn(),
  listActiveForGame: vi.fn().mockResolvedValue(active),
  findByRegistration: vi.fn(),
  claimDelivery: vi
    .fn()
    .mockResolvedValue({ status: 'CLAIMED', claimToken: 'claim' }),
  markDelivered: vi.fn().mockResolvedValue(undefined),
  releaseDelivery: vi.fn().mockResolvedValue(undefined),
});
