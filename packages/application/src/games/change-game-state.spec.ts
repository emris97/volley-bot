import {
  asGameId,
  asGroupId,
  asUserId,
  type Game,
  type GameState,
  type UserId,
} from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { ChangeGameState } from './change-game-state.js';
import type { GameRepository } from './ports.js';

const groupId = asGroupId('20000000-0000-4000-8000-000000000001');
const gameId = asGameId('10000000-0000-4000-8000-000000000001');
const actorUserId = asUserId('30000000-0000-4000-8000-000000000001');

describe('ChangeGameState', () => {
  it('checks the game revision under lock and updates a valid transition', async () => {
    const updateState = vi.fn(async (state: GameState) =>
      game({ state, revision: 4 }),
    );
    const useCase = new ChangeGameState(
      { requireOrganizer: async () => undefined },
      repositoryFor(game({ state: 'OPEN', revision: 3 }), updateState),
    );

    await expect(
      useCase.execute({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 3,
        targetState: 'CLOSED',
      }),
    ).resolves.toMatchObject({ state: 'CLOSED', revision: 4 });
    expect(updateState).toHaveBeenCalledWith('CLOSED', actorUserId);
  });

  it('rejects a stale revision without writing', async () => {
    const updateState = vi.fn(async () => game());
    const useCase = new ChangeGameState(
      { requireOrganizer: async () => undefined },
      repositoryFor(game({ state: 'OPEN', revision: 4 }), updateState),
    );

    await expect(
      useCase.execute({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 3,
        targetState: 'CLOSED',
      }),
    ).rejects.toThrow('Игра уже была изменена. Откройте актуальную версию.');
    expect(updateState).not.toHaveBeenCalled();
  });

  it('returns an already reached target without a second event', async () => {
    const current = game({ state: 'CLOSED', revision: 4 });
    const updateState = vi.fn(async () => game());
    const useCase = new ChangeGameState(
      { requireOrganizer: async () => undefined },
      repositoryFor(current, updateState),
    );

    await expect(
      useCase.execute({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 3,
        targetState: 'CLOSED',
      }),
    ).resolves.toBe(current);
    expect(updateState).not.toHaveBeenCalled();
  });

  it('rejects an invalid transition without writing', async () => {
    const updateState = vi.fn(async () => game());
    const useCase = new ChangeGameState(
      { requireOrganizer: async () => undefined },
      repositoryFor(game({ state: 'OPEN', revision: 3 }), updateState),
    );

    await expect(
      useCase.execute({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 3,
        targetState: 'COMPLETED',
      }),
    ).rejects.toThrow(/invalid game transition/i);
    expect(updateState).not.toHaveBeenCalled();
  });
});

const repositoryFor = (
  current: Game,
  updateState: (state: GameState, actorUserId?: UserId) => Promise<Game>,
): GameRepository => ({
  insert: async (value) => value,
  withLockedGame: async (_groupId, _gameId, callback) =>
    callback(current, { updateState }),
});

const game = (overrides: Partial<Game> = {}): Game => ({
  id: gameId,
  groupId,
  sourceTemplateId: null,
  name: 'Evening game',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-10T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 12,
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
  revision: 3,
  scheduleRevision: 2,
  canonicalTelegramMessageId: 5n,
  ...overrides,
});
