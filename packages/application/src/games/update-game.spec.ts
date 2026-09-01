import { asGameId, asGroupId, asUserId } from '@volley/domain';
import { expect, it } from 'vitest';
import { UpdateGame } from './update-game.js';

it('authorizes and applies a revisioned capacity update', async () => {
  const calls: unknown[] = [];
  const command = {
    groupId: asGroupId('group'),
    gameId: asGameId('game'),
    actorUserId: asUserId('organizer'),
    expectedRevision: 3,
    changes: { capacity: 1 },
  };
  const useCase = new UpdateGame(
    { requireOrganizer: async () => undefined },
    {
      updateGame: async (input) => {
        calls.push(input);
        return { scheduleRevision: 4, rosterCount: 1, waitlistCount: 1 };
      },
    },
  );

  const result = await useCase.execute(command);

  expect(result).toEqual({
    scheduleRevision: 4,
    rosterCount: 1,
    waitlistCount: 1,
  });
  expect(calls).toEqual([command]);
});
