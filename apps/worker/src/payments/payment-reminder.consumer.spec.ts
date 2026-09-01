import { describe, expect, it, vi } from 'vitest';
import { JsonLogger, MetricsRegistry } from '@volley/application';
import { asGroupId, asTelegramId, asUserId } from '@volley/domain';
import { TelegramPrivateChatUnavailableError } from '@volley/telegram';
import { PaymentReminderConsumer } from './payment-reminder.consumer.js';

const payload = {
  channel: 'PRIVATE',
  groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
  gameId: '018f6ba0-62d2-7bd1-8f13-12e0c8424612',
  chargeId: '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
  settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424630',
};

const recipient = {
  groupId: asGroupId(payload.groupId),
  chargeId: payload.chargeId,
  userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424640'),
  telegramUserId: asTelegramId('42'),
  displayName: 'Player',
  amountMinor: 65000n,
  currency: 'RUB' as const,
};

describe('PaymentReminderConsumer', () => {
  it('claims and delivers a payment reminder only to the private recipient', async () => {
    const repository = repositoryStub();
    repository.findRecipient.mockResolvedValue(recipient);
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new PaymentReminderConsumer(repository, sender);

    await consumer.process(payload, 'outbox:event:payment-reminder');

    expect(sender.send).toHaveBeenCalledWith(recipient);
    expect(repository.markDelivered).toHaveBeenCalledWith(
      'outbox:event:payment-reminder',
      payload.chargeId,
      'claim',
    );
    expect(repository.markTerminalFailure).not.toHaveBeenCalled();
  });

  it('durably terminates delivery when the charge no longer has a private recipient', async () => {
    const repository = repositoryStub();
    repository.findRecipient.mockResolvedValue(null);
    const sender = { send: vi.fn() };
    const consumer = new PaymentReminderConsumer(repository, sender);

    await expect(
      consumer.process(payload, 'outbox:event:payment-reminder'),
    ).resolves.toBeUndefined();

    expect(sender.send).not.toHaveBeenCalled();
    expect(repository.markTerminalFailure).toHaveBeenCalledWith(
      'outbox:event:payment-reminder',
      payload.chargeId,
      'claim',
      'NO_PRIVATE_RECIPIENT',
    );
    expect(repository.releaseDelivery).not.toHaveBeenCalled();
  });

  it('marks blocked private chats terminal without falling back to a group', async () => {
    const repository = repositoryStub();
    repository.findRecipient.mockResolvedValue(recipient);
    const sender = {
      send: vi
        .fn()
        .mockRejectedValue(new TelegramPrivateChatUnavailableError()),
    };
    const consumer = new PaymentReminderConsumer(repository, sender);

    await expect(
      consumer.process(payload, 'outbox:event:payment-reminder'),
    ).resolves.toBeUndefined();

    expect(repository.markUnavailable).toHaveBeenCalledWith(recipient.userId);
    expect(repository.markTerminalFailure).toHaveBeenCalledWith(
      'outbox:event:payment-reminder',
      payload.chargeId,
      'claim',
      'PRIVATE_CHAT_UNAVAILABLE',
    );
    expect(repository.releaseDelivery).not.toHaveBeenCalled();
  });

  it('releases retryable failures and skips already completed deliveries', async () => {
    const repository = repositoryStub();
    repository.findRecipient.mockResolvedValue(recipient);
    const sender = { send: vi.fn().mockRejectedValue(new Error('temporary')) };
    const consumer = new PaymentReminderConsumer(repository, sender);

    await expect(
      consumer.process(payload, 'outbox:event:payment-reminder'),
    ).rejects.toThrow('temporary');
    expect(repository.releaseDelivery).toHaveBeenCalledWith(
      'outbox:event:payment-reminder',
      payload.chargeId,
      'claim',
    );

    repository.claimDelivery.mockResolvedValue({ status: 'COMPLETED' });
    sender.send.mockClear();
    await consumer.process(payload, 'outbox:event:payment-reminder');
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('releases the delivery claim when authoritative recipient lookup fails', async () => {
    const repository = repositoryStub();
    repository.findRecipient.mockRejectedValue(new Error('database down'));
    const consumer = new PaymentReminderConsumer(repository, {
      send: vi.fn(),
    });

    await expect(
      consumer.process(payload, 'outbox:event:payment-reminder'),
    ).rejects.toThrow('database down');

    expect(repository.releaseDelivery).toHaveBeenCalledWith(
      'outbox:event:payment-reminder',
      payload.chargeId,
      'claim',
    );
  });

  it('records retry metrics and correlated logs through the production consumer', async () => {
    const repository = repositoryStub();
    repository.findRecipient.mockResolvedValue(recipient);
    const metrics = new MetricsRegistry();
    const logs: string[] = [];
    const consumer = new PaymentReminderConsumer(
      repository,
      { send: vi.fn().mockResolvedValue(undefined) },
      metrics,
      new JsonLogger({ output: (line) => logs.push(line) }),
    );

    await consumer.process(payload, 'outbox:event:payment-reminder', 1);

    expect(metrics.render()).toContain(
      'volley_job_retries_total{queue="payment-reminders"} 1',
    );
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        message: 'Worker job started',
        jobId: 'outbox:event:payment-reminder',
        groupId: payload.groupId,
        gameId: payload.gameId,
      }),
      expect.objectContaining({
        message: 'Worker job completed',
        jobId: 'outbox:event:payment-reminder',
        groupId: payload.groupId,
        gameId: payload.gameId,
      }),
    ]);
  });
});

const repositoryStub = () => ({
  claimDelivery: vi
    .fn()
    .mockResolvedValue({ status: 'CLAIMED', claimToken: 'claim' }),
  findRecipient: vi.fn(),
  markDelivered: vi.fn().mockResolvedValue(undefined),
  markTerminalFailure: vi.fn().mockResolvedValue(undefined),
  releaseDelivery: vi.fn().mockResolvedValue(undefined),
  markUnavailable: vi.fn().mockResolvedValue(undefined),
});
