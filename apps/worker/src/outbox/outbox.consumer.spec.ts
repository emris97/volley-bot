import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import {
  MetricsRegistry,
  OutboxDispatcher,
  type ClaimedOutboxEvent,
  type JobPublisher,
  type OutboxClaimStore,
} from '@volley/application';
import { BullMqJobPublisher, OutboxConsumer } from './outbox.consumer.js';

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
    const consumer = new OutboxConsumer(
      { dispatchOnce } as unknown as OutboxDispatcher,
      closeResources,
      60_000,
      purgeExpiredPaymentState,
    );

    await consumer.start();
    await consumer.stop();

    expect(dispatchOnce).toHaveBeenCalledOnce();
    expect(purgeExpiredPaymentState).toHaveBeenCalledOnce();
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
