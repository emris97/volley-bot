import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import {
  MetricsRegistry,
  OutboxDispatcher,
  type ClaimedOutboxEvent,
  type JobPublisher,
  type OutboxClaimStore,
} from '@volley/application';
import {
  BullMqJobPublisher,
  OutboxConsumer,
  PublishedOutboxRecovery,
} from './outbox.consumer.js';

describe('OutboxDispatcher', () => {
  it('publishes retries with the same deterministic BullMQ job id', async () => {
    const event: ClaimedOutboxEvent = {
      id: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      type: 'GAME_CREATED',
      payload: { gameId: 'game-1' },
      occurredAt: new Date('2026-09-01T12:00:00.000Z'),
    };
    const store: OutboxClaimStore = {
      claimBatch: vi
        .fn()
        .mockResolvedValueOnce([event])
        .mockResolvedValueOnce([event]),
      markPublished: vi
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const publisher: JobPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    const dispatcher = new OutboxDispatcher(store, publisher, {
      batchSize: 10,
      leaseDurationMs: 60_000,
      now: () => new Date('2026-09-01T12:00:00.000Z'),
    });

    await expect(dispatcher.dispatchOnce()).rejects.toThrow(
      'database unavailable',
    );
    await expect(dispatcher.dispatchOnce()).rejects.toThrow(
      'database unavailable',
    );

    expect(publisher.publish).toHaveBeenNthCalledWith(1, {
      id: `outbox:${event.id}`,
      type: event.type,
      payload: event.payload,
      occurredAt: event.occurredAt,
    });
    expect(publisher.publish).toHaveBeenNthCalledWith(2, {
      id: `outbox:${event.id}`,
      type: event.type,
      payload: event.payload,
      occurredAt: event.occurredAt,
    });
  });

  it('releases an event after publishing fails and continues the batch', async () => {
    const first = event('first');
    const second = event('second');
    const store: OutboxClaimStore = {
      claimBatch: vi.fn().mockResolvedValue([first, second]),
      markPublished: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const publisher: JobPublisher = {
      publish: vi
        .fn()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const dispatcher = new OutboxDispatcher(store, publisher);

    const result = await dispatcher.dispatchOnce();

    expect(result).toEqual({ claimed: 2, published: 1, failed: 1 });
    expect(store.release).toHaveBeenCalledWith(first.id, 'redis unavailable');
    expect(store.markPublished).toHaveBeenCalledWith(second.id);
  });
});

describe('BullMqJobPublisher', () => {
  it('uses a BullMQ-safe deterministic id for an outbox event', async () => {
    const queue = {
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
    };
    const publisher = new BullMqJobPublisher(queue as unknown as Queue);

    await publisher.publish({
      id: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      type: 'GAME_CREATED',
      payload: {},
      occurredAt: new Date('2026-09-01T12:00:00.000Z'),
    });

    expect(queue.add).toHaveBeenCalledWith(
      'GAME_CREATED',
      {},
      expect.objectContaining({
        jobId: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610:event',
      }),
    );
  });

  it('revives a failed deterministic outbox job', async () => {
    const failed = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    };
    const queue = { getJob: vi.fn().mockResolvedValue(failed), add: vi.fn() };
    const publisher = new BullMqJobPublisher(queue as unknown as Queue);

    await publisher.publish({
      id: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      type: 'GAME_CREATED',
      payload: {},
      occurredAt: new Date(),
    });

    expect(failed.retry).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('replays a completed router job so failed children can be revived', async () => {
    const completed = {
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn(),
    };
    const queue = {
      getJob: vi.fn().mockResolvedValue(completed),
      add: vi.fn(),
    };
    const publisher = new BullMqJobPublisher(queue as unknown as Queue);

    await publisher.publish({
      id: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      type: 'GAME_RECOVERY_REFRESH',
      payload: {},
      occurredAt: new Date(),
    });

    expect(completed.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('does not recreate a completed router job during repeat-safe recovery', async () => {
    const completed = {
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn(),
    };
    const queue = {
      getJob: vi.fn().mockResolvedValue(completed),
      add: vi.fn(),
    };
    const publisher = new BullMqJobPublisher(queue as unknown as Queue);

    await publisher.publishRecovered({
      id: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      type: 'GAME_UPDATED',
      payload: { materialFields: ['venue'] },
      occurredAt: new Date(),
    });

    expect(completed.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('records retry, queue depth, and outbox lag through the production publisher', async () => {
    const failed = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const queue = {
      name: 'volley-outbox',
      getJob: vi.fn().mockResolvedValue(failed),
      add: vi.fn(),
      count: vi.fn().mockResolvedValue(4),
    };
    const metrics = new MetricsRegistry();
    const publisher = new BullMqJobPublisher(
      queue as unknown as Queue,
      metrics,
      () => new Date('2026-09-02T12:00:05.000Z'),
    );

    await publisher.publish({
      id: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      type: 'GAME_CREATED',
      payload: {},
      occurredAt: new Date('2026-09-02T12:00:00.000Z'),
    });

    const rendered = metrics.render();
    expect(rendered).toContain('volley_job_retries_total{queue="outbox"} 1');
    expect(rendered).toContain('volley_queue_depth{queue="outbox"} 4');
    expect(rendered).toContain('volley_outbox_lag_seconds_sum 5');
    expect(rendered).toContain('volley_outbox_lag_seconds_count 1');
  });
});

describe('PublishedOutboxRecovery', () => {
  it('replays bounded pages under original event identities and pauses after a sweep', async () => {
    let now = 1_000;
    const first = recoveryEvent('00000000-0000-0000-0000-000000000001', 1);
    const second = recoveryEvent('00000000-0000-0000-0000-000000000002', 2);
    const third = recoveryEvent('00000000-0000-0000-0000-000000000003', 3);
    const store = {
      listRecoveryBatch: vi
        .fn()
        .mockResolvedValueOnce([first, second])
        .mockResolvedValueOnce([third])
        .mockResolvedValueOnce([]),
    };
    const publisher = {
      publishRecovered: vi.fn().mockResolvedValue(undefined),
    };
    const recovery = new PublishedOutboxRecovery(store, publisher, {
      pageSize: 2,
      sweepIntervalMs: 60_000,
      now: () => now,
    });

    await recovery.replayOnce();
    await recovery.replayOnce();
    await recovery.replayOnce();

    expect(store.listRecoveryBatch).toHaveBeenNthCalledWith(1, 2, undefined);
    expect(store.listRecoveryBatch).toHaveBeenNthCalledWith(2, 2, {
      occurredAt: second.occurredAt,
      id: second.id,
    });
    expect(store.listRecoveryBatch).toHaveBeenCalledTimes(2);
    expect(publisher.publishRecovered).toHaveBeenNthCalledWith(1, {
      id: `outbox:${first.id}`,
      type: first.type,
      payload: {
        ...first.payload,
        groupId: first.groupId,
        aggregateType: first.aggregateType,
        aggregateId: first.aggregateId,
      },
      occurredAt: first.occurredAt,
    });
    expect(publisher.publishRecovered).toHaveBeenCalledTimes(3);

    now += 60_000;
    await recovery.replayOnce();
    expect(store.listRecoveryBatch).toHaveBeenNthCalledWith(3, 2, undefined);
  });
});

describe('OutboxConsumer maintenance', () => {
  it('purges one bounded batch of expired payment state per tick', async () => {
    const dispatchOnce = vi.fn().mockResolvedValue({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    const purgeExpiredPaymentState = vi.fn().mockResolvedValue({
      draftsDeleted: 0,
      inputSessionsDeleted: 0,
    });
    const closeResources = vi.fn().mockResolvedValue(undefined);
    const replayOnce = vi.fn().mockResolvedValue(undefined);
    const consumer = new OutboxConsumer(
      { dispatchOnce } as unknown as OutboxDispatcher,
      closeResources,
      60_000,
      purgeExpiredPaymentState,
      undefined,
      { replayOnce },
    );

    await consumer.start();
    await consumer.stop();

    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(purgeExpiredPaymentState).toHaveBeenCalledOnce();
    expect(replayOnce).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
  });

  it('awaits a held in-flight tick before closing resources', async () => {
    let releaseDispatch!: () => void;
    const heldDispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatchOnce = vi.fn().mockReturnValue(heldDispatch);
    const closeResources = vi.fn().mockResolvedValue(undefined);
    const consumer = new OutboxConsumer(
      { dispatchOnce } as unknown as OutboxDispatcher,
      closeResources,
      60_000,
    );

    const starting = consumer.start();
    await vi.waitFor(() => expect(dispatchOnce).toHaveBeenCalledOnce());
    const stopping = consumer.stop();
    await Promise.resolve();

    expect(closeResources).not.toHaveBeenCalled();
    releaseDispatch();
    await Promise.all([starting, stopping]);
    expect(closeResources).toHaveBeenCalledOnce();
  });
});

const event = (id: string): ClaimedOutboxEvent => ({
  id,
  type: 'GAME_CHANGED',
  payload: {},
  occurredAt: new Date('2026-09-01T12:00:00.000Z'),
});

const recoveryEvent = (id: string, second: number) => ({
  id,
  type: 'GAME_UPDATED',
  payload: { materialFields: ['venue'] },
  occurredAt: new Date(`2026-09-01T12:00:0${second}.000Z`),
  groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
  aggregateType: 'GAME',
  aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
});
