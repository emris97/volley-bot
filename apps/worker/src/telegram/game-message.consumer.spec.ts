import { describe, expect, it, vi } from 'vitest';
import {
  GameMessageConsumer,
  OutboxEventRouter,
} from './game-message.consumer.js';

describe('GameMessageConsumer', () => {
  it('refreshes a canonical game message', async () => {
    const updater = { refresh: vi.fn() };
    const consumer = new GameMessageConsumer(updater as never);

    await consumer.process('WAITLIST_PROMOTED', {
      groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
      aggregateType: 'GAME',
      aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      registrationId: '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
    });

    expect(updater.refresh).toHaveBeenCalledOnce();
  });

  it('fans promotion and canonical refresh into independent jobs', async () => {
    const canonicalQueue = { getJob: vi.fn(), add: vi.fn() };
    const notificationQueue = { getJob: vi.fn(), add: vi.fn() };
    const router = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
    );

    await router.process(
      'WAITLIST_PROMOTED',
      { registrationId: 'registration' },
      'outbox:event:event',
    );

    expect(canonicalQueue.add).toHaveBeenCalledWith(
      'WAITLIST_PROMOTED',
      expect.anything(),
      expect.objectContaining({ jobId: 'outbox:event:canonical' }),
    );
    expect(notificationQueue.add).toHaveBeenCalledWith(
      'WAITLIST_PROMOTED',
      expect.anything(),
      expect.objectContaining({ jobId: 'outbox:event:notification' }),
    );
  });
});
