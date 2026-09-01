import { describe, expect, it, vi } from 'vitest';
import { asGameId, asGroupId, type Game } from '@volley/domain';
import { ReconcileGameJobs } from './reconcile-game-jobs.js';

describe('ReconcileGameJobs', () => {
  it('does not recreate a desired job that already completed', async () => {
    const current = game();
    const id = `OPEN_REGISTRATION:${current.id}:1`;
    const store = {
      listForGame: vi.fn().mockResolvedValue([
        {
          id,
          kind: 'OPEN_REGISTRATION' as const,
          runAt: current.registrationOpensAt,
          scheduleRevision: 1,
          completed: true,
        },
      ]),
      upsert: vi.fn(),
      remove: vi.fn(),
    };
    const scheduler = { ensure: vi.fn(), remove: vi.fn() };

    await new ReconcileGameJobs(store, scheduler).execute(current, []);

    expect(scheduler.ensure).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
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
  registrationClosesAt: null,
  tentativePromptAt: new Date('2026-09-03T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-03T17:00:00.000Z'),
  reminderAt: new Date('2026-09-04T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'SCHEDULED',
  scheduleRevision: 1,
  canonicalTelegramMessageId: null,
});
