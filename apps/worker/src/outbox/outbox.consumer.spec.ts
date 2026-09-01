import { describe, expect, it, vi } from 'vitest';
import {
  OutboxDispatcher,
  type ClaimedOutboxEvent,
  type JobPublisher,
  type OutboxClaimStore,
} from '@volley/application';

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

const event = (id: string): ClaimedOutboxEvent => ({
  id,
  type: 'GAME_CHANGED',
  payload: {},
  occurredAt: new Date('2026-09-01T12:00:00.000Z'),
});
