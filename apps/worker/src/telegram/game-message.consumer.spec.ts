import { describe, expect, it, vi } from 'vitest';
import {
  JsonLogger,
  MetricsRegistry,
  type LogOutput,
} from '@volley/application';
import {
  GameMessageConsumer,
  GameMessageWorkerRuntime,
  OutboxEventRouter,
} from './game-message.consumer.js';
import { WorkerRunStateRegistry } from '../observability/worker-run-state.js';

describe('GameMessageConsumer', () => {
  it('marks an unexpectedly resolved BullMQ consumer non-ready', async () => {
    const state = new WorkerRunStateRegistry(['volley-test']);
    const runtime = new GameMessageWorkerRuntime(
      [
        {
          name: 'volley-test',
          run: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        } as never,
      ],
      vi.fn().mockResolvedValue(undefined),
      state,
    );

    await runtime.start();
    await vi.waitFor(() => expect(state.status('volley-test')).toBe('FAILED'));

    expect(state.isReady()).toBe(false);
  });

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
      { getJob: vi.fn(), add: vi.fn() } as never,
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

  it('routes ordinary game updates only to the canonical refresh queue', async () => {
    const canonicalQueue = { getJob: vi.fn(), add: vi.fn() };
    const notificationQueue = { getJob: vi.fn(), add: vi.fn() };
    const router = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
      { getJob: vi.fn(), add: vi.fn() } as never,
    );

    await router.process(
      'GAME_UPDATED',
      {
        aggregateType: 'GAME',
        aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
        groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
        materialFields: [],
      },
      'outbox:ordinary:event',
    );

    expect(canonicalQueue.add).toHaveBeenCalledOnce();
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('routes material updates and cancellations to one deterministic notification child', async () => {
    const canonicalQueue = { getJob: vi.fn(), add: vi.fn() };
    const notificationQueue = { getJob: vi.fn(), add: vi.fn() };
    const router = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
      { getJob: vi.fn(), add: vi.fn() } as never,
    );
    const materialPayload = {
      aggregateType: 'GAME',
      aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
      materialFields: ['startsAt'],
      startsAtBefore: '2026-09-10T15:00:00.000Z',
      startsAtAfter: '2026-09-11T16:00:00.000Z',
    };

    await router.process(
      'GAME_UPDATED',
      materialPayload,
      'outbox:material:event',
    );
    await router.process(
      'GAME_STATE_CHANGED',
      { ...materialPayload, from: 'OPEN', to: 'CANCELLED' },
      'outbox:cancelled:event',
    );

    expect(notificationQueue.add).toHaveBeenNthCalledWith(
      1,
      'GAME_UPDATED',
      materialPayload,
      expect.objectContaining({ jobId: 'outbox:material:notification' }),
    );
    expect(notificationQueue.add).toHaveBeenNthCalledWith(
      2,
      'GAME_STATE_CHANGED',
      expect.objectContaining({ to: 'CANCELLED' }),
      expect.objectContaining({ jobId: 'outbox:cancelled:notification' }),
    );
  });

  it('retries a failed material-notification child with the same identity', async () => {
    const failedChild = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const notificationQueue = {
      getJob: vi.fn().mockResolvedValue(failedChild),
      add: vi.fn(),
    };
    const router = new OutboxEventRouter(
      { getJob: vi.fn(), add: vi.fn() } as never,
      notificationQueue as never,
      { getJob: vi.fn(), add: vi.fn() } as never,
    );

    await router.process(
      'GAME_UPDATED',
      {
        aggregateType: 'GAME',
        aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
        groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
        materialFields: ['venue'],
      },
      'outbox:same-event:event',
    );

    expect(notificationQueue.getJob).toHaveBeenCalledWith(
      'outbox:same-event:notification',
    );
    expect(failedChild.retry).toHaveBeenCalledOnce();
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('does not notify for a non-cancellation lifecycle transition', async () => {
    const canonicalQueue = { getJob: vi.fn(), add: vi.fn() };
    const notificationQueue = { getJob: vi.fn(), add: vi.fn() };
    const router = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
      { getJob: vi.fn(), add: vi.fn() } as never,
    );

    await router.process(
      'GAME_STATE_CHANGED',
      {
        aggregateType: 'GAME',
        aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
        groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
        from: 'OPEN',
        to: 'CLOSED',
      },
      'outbox:closed:event',
    );

    expect(canonicalQueue.add).toHaveBeenCalledOnce();
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('routes payment reminders to their dedicated private-delivery queue', async () => {
    const canonicalQueue = { getJob: vi.fn(), add: vi.fn() };
    const notificationQueue = { getJob: vi.fn(), add: vi.fn() };
    const paymentReminderQueue = { getJob: vi.fn(), add: vi.fn() };
    const router = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
      paymentReminderQueue as never,
    );

    await router.process(
      'PAYMENT_REMINDER_REQUESTED',
      { chargeId: 'charge', channel: 'PRIVATE' },
      'outbox:event:event',
    );

    expect(paymentReminderQueue.add).toHaveBeenCalledWith(
      'PAYMENT_REMINDER_REQUESTED',
      expect.objectContaining({ chargeId: 'charge', channel: 'PRIVATE' }),
      expect.objectContaining({ jobId: 'outbox:event:payment-reminder' }),
    );
    expect(canonicalQueue.add).not.toHaveBeenCalled();
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('records retry and correlation through the production outbox router', async () => {
    const canonicalQueue = { getJob: vi.fn(), add: vi.fn() };
    const notificationQueue = { getJob: vi.fn(), add: vi.fn() };
    const metrics = new MetricsRegistry();
    const output: string[] = [];
    const router = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
      { getJob: vi.fn(), add: vi.fn() } as never,
      metrics,
      new JsonLogger({
        output: (line: LogOutput) => output.push(line),
      }),
    );
    const jobId = 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424612:event';
    const groupId = '018f6ba0-62d2-7bd1-8f13-12e0c8424611';
    const gameId = '018f6ba0-62d2-7bd1-8f13-12e0c8424610';

    await router.process(
      'GAME_UPDATED',
      { groupId, aggregateType: 'GAME', aggregateId: gameId },
      jobId,
      1,
    );

    expect(metrics.render()).toContain(
      'volley_job_retries_total{queue="outbox"} 1',
    );
    expect(output.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        message: 'Worker job completed',
        jobId,
        groupId,
        gameId,
      }),
    );
  });
});
