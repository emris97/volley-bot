import { describe, expect, it, vi } from 'vitest';
import {
  JsonLogger,
  MetricsRegistry,
  type LogOutput,
} from '@volley/application';
import { asGameId, asGroupId, type Game } from '@volley/domain';
import {
  BullMqDelayedJobScheduler,
  GameSchedulerConsumer,
  GameSchedulerRuntime,
} from './game-scheduler.consumer.js';
import { WorkerRunStateRegistry } from '../observability/worker-run-state.js';

describe('GameSchedulerConsumer', () => {
  it.each([
    ['stale revision', { scheduleRevision: 2 }],
    ['cancelled game', { state: 'CANCELLED' as const }],
    ['completed game', { state: 'COMPLETED' as const }],
  ])('skips a notification for a %s', async (_label, changes) => {
    const current = { ...game(), ...changes };
    const notify = vi.fn();
    const consumer = new GameSchedulerConsumer(
      {
        findById: vi.fn().mockResolvedValue(current),
        withLockedGame: vi.fn(),
      },
      notify,
    );

    await consumer.process({
      id: `REMIND_PARTICIPANTS:${current.id}:1`,
      kind: 'REMIND_PARTICIPANTS',
      groupId: current.groupId!,
      gameId: current.id!,
      scheduleRevision: 1,
      runAt: current.reminderAt,
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('records retried transaction conflicts with worker job correlation', async () => {
    const current = game();
    const conflict = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });
    const metrics = new MetricsRegistry();
    const output: string[] = [];
    const consumer = new GameSchedulerConsumer(
      {
        findById: vi.fn().mockRejectedValue(conflict),
        withLockedGame: vi.fn(),
      },
      undefined,
      metrics,
      new JsonLogger({
        output: (line: LogOutput) => output.push(line),
      }),
    );
    const job = {
      id: `REMIND_PARTICIPANTS:${current.id}:1`,
      kind: 'REMIND_PARTICIPANTS' as const,
      groupId: current.groupId!,
      gameId: current.id!,
      scheduleRevision: 1,
      runAt: current.reminderAt,
    };

    await expect(consumer.process(job, 1)).rejects.toThrow(
      'serialization failure',
    );

    expect(metrics.render()).toContain(
      'volley_job_retries_total{queue="game-scheduler"} 1',
    );
    expect(metrics.render()).toContain(
      'volley_transaction_conflicts_total{operation="game-scheduler"} 1',
    );
    expect(output.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        message: 'Worker job failed',
        jobId: job.id,
        groupId: current.groupId,
        gameId: current.id,
      }),
    );
  });
});

describe('BullMqDelayedJobScheduler', () => {
  it('revives an existing failed deterministic job', async () => {
    const failed = {
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn(),
    };
    const queue = { getJob: vi.fn().mockResolvedValue(failed), add: vi.fn() };
    const current = game();
    const scheduler = new BullMqDelayedJobScheduler(queue as never);

    await scheduler.ensure({
      id: `REMIND_PARTICIPANTS:${current.id}:1`,
      kind: 'REMIND_PARTICIPANTS',
      groupId: current.groupId!,
      gameId: current.id!,
      scheduleRevision: 1,
      runAt: current.reminderAt,
    });

    expect(failed.retry).toHaveBeenCalledOnce();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('GameSchedulerRuntime shutdown', () => {
  it('marks an unexpected BullMQ run rejection non-ready without leaking the rejection', async () => {
    const state = new WorkerRunStateRegistry(['game-scheduler']);
    const worker = {
      name: 'game-scheduler',
      run: vi.fn().mockRejectedValue(new Error('consumer failed')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new GameSchedulerRuntime(
      worker as never,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
      60_000,
      state,
    );

    await runtime.start();
    await vi.waitFor(() =>
      expect(state.status('game-scheduler')).toBe('FAILED'),
    );

    expect(state.isReady()).toBe(false);
  });

  it('awaits a held reconciliation before closing worker resources', async () => {
    let releaseReconciliation!: () => void;
    const heldReconciliation = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const calls: string[] = [];
    const worker = {
      name: 'game-scheduler',
      run: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(async () => void calls.push('worker')),
    };
    const reconcile = vi.fn().mockReturnValue(heldReconciliation);
    const closeResources = vi.fn(async () => void calls.push('resources'));
    const runtime = new GameSchedulerRuntime(
      worker as never,
      reconcile,
      closeResources,
      60_000,
    );

    const starting = runtime.start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    const stopping = runtime.stop();
    await Promise.resolve();

    expect(worker.close).not.toHaveBeenCalled();
    expect(closeResources).not.toHaveBeenCalled();
    releaseReconciliation();
    await Promise.all([starting, stopping]);
    expect(calls).toEqual(['worker', 'resources']);
  });
});

const game = (): Game => ({
  id: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  sourceTemplateId: null,
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-04T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 12,
  timeZone: 'Europe/Astrakhan',
  registrationOpensAt: new Date('2026-08-28T16:00:00.000Z'),
  registrationClosesAt: new Date('2026-09-04T15:00:00.000Z'),
  tentativePromptAt: new Date('2026-09-03T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-03T17:00:00.000Z'),
  reminderAt: new Date('2026-09-04T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'OPEN',
  scheduleRevision: 1,
  canonicalTelegramMessageId: null,
});
