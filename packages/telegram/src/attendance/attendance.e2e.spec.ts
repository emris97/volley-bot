import { expect, it } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  asUserId,
} from '@volley/domain';
import { AttendanceHandlers } from './attendance.handlers.js';

it('presents a corrected preview before final confirmation', async () => {
  const calls: unknown[] = [];
  const handlers = new AttendanceHandlers(
    {
      resolve: async () => ({
        groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
        gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
        userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613'),
      }),
    },
    {
      execute: async (command) => {
        calls.push(command);
        return {
          groupId: command.groupId,
          gameId: command.gameId,
          revision: command.expectedRevision + 1,
          finalized: command.finalize,
          entries: [],
        };
      },
    },
  );

  const result = await handlers.preview({
    telegramUserId: asTelegramId('42'),
    gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
    expectedRevision: 3,
    excludedRegistrationIds: [
      asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424620'),
    ],
    manualParticipants: [],
  });

  expect(result.finalized).toBe(false);
  expect(calls).toEqual([
    expect.objectContaining({
      expectedRevision: 3,
      finalize: false,
    }),
  ]);
});
