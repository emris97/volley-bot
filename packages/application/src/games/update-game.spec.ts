import { asGameId, asGroupId, asUserId, type Game } from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { UpdateGame } from './update-game.js';

const game = (overrides: Partial<Game> = {}): Game => ({
  id: asGameId('10000000-0000-4000-8000-000000000001'),
  groupId: asGroupId('20000000-0000-4000-8000-000000000001'),
  sourceTemplateId: null,
  name: 'Evening game',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-10T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 1,
  timeZone: 'Europe/Astrakhan',
  registrationOpensAt: new Date('2026-09-01T16:00:00.000Z'),
  registrationClosesAt: new Date('2026-09-10T15:00:00.000Z'),
  tentativePromptAt: new Date('2026-09-09T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-09T17:00:00.000Z'),
  reminderAt: new Date('2026-09-10T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'OPEN',
  revision: 4,
  scheduleRevision: 2,
  canonicalTelegramMessageId: 5n,
  ...overrides,
});

describe('UpdateGame', () => {
  it('authorizes and applies normalized changes against the game revision', async () => {
    const calls: unknown[] = [];
    const command = {
      groupId: asGroupId('20000000-0000-4000-8000-000000000001'),
      gameId: asGameId('10000000-0000-4000-8000-000000000001'),
      actorUserId: asUserId('30000000-0000-4000-8000-000000000001'),
      expectedRevision: 3,
      changes: { name: '  Evening game  ', capacity: 1 },
    };
    const useCase = new UpdateGame(
      { requireOrganizer: async () => undefined },
      {
        updateGame: async (input) => {
          calls.push(input);
          return {
            game: game(),
            rosterCount: 1,
            waitlistCount: 1,
            materialFields: [],
          };
        },
      },
      () => new Date('2026-09-06T00:00:00.000Z'),
    );

    const result = await useCase.execute(command);

    expect(result).toEqual({
      game: game(),
      rosterCount: 1,
      waitlistCount: 1,
      materialFields: [],
    });
    expect(calls).toEqual([
      {
        ...command,
        changes: { name: 'Evening game', capacity: 1 },
      },
    ]);
  });

  it('rejects a past start before calling persistence', async () => {
    const updateGame = vi.fn();
    const useCase = new UpdateGame(
      { requireOrganizer: async () => undefined },
      { updateGame },
      () => new Date('2026-09-06T00:00:00.000Z'),
    );

    await expect(
      useCase.execute({
        groupId: asGroupId('20000000-0000-4000-8000-000000000001'),
        gameId: asGameId('10000000-0000-4000-8000-000000000001'),
        actorUserId: asUserId('30000000-0000-4000-8000-000000000001'),
        expectedRevision: 3,
        changes: { startsAt: new Date('2026-09-05T23:59:59.000Z') },
      }),
    ).rejects.toThrow('Время начала игры должно быть в будущем.');
    expect(updateGame).not.toHaveBeenCalled();
  });
});
