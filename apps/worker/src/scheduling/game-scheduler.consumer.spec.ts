import { describe, expect, it, vi } from 'vitest';
import { asGameId, asGroupId, type Game } from '@volley/domain';
import {
  BullMqDelayedJobScheduler,
  GameSchedulerConsumer,
} from './game-scheduler.consumer.js';

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
