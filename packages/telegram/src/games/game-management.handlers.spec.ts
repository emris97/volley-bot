import { asGameId, asGroupId, asUserId } from '@volley/domain';
import { expect, it } from 'vitest';
import { GameManagementHandlers } from './game-management.handlers.js';

it('delegates privileged state changes to the authorized application use case', async () => {
  const calls: unknown[] = [];
  const handlers = new GameManagementHandlers(
    {
      execute: async (command) => {
        calls.push(command);
        return { state: 'CLOSED' as const };
      },
    },
    {
      execute: async () => ({
        scheduleRevision: 1,
        rosterCount: 0,
        waitlistCount: 0,
      }),
    },
  );
  const command = {
    groupId: asGroupId('group'),
    gameId: asGameId('game'),
    actorUserId: asUserId('organizer'),
    targetState: 'CLOSED' as const,
  };

  await handlers.changeState(command);

  expect(calls).toEqual([command]);
});
