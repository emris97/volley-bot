import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asUserId,
} from '@volley/domain';
import { expect, it } from 'vitest';
import { RegisterParticipant } from './register-participant.js';

it('uses a fresh membership priority and returns repository placement', async () => {
  const calls: unknown[] = [];
  const useCase = new RegisterParticipant(
    { priorityFor: async () => 1 },
    {
      registerParticipant: async (input) => {
        calls.push(input);
        return {
          registrationId: asRegistrationId('registration-1'),
          state: 'ROSTERED',
          rosterPosition: 1,
        };
      },
      registerGuest: async () => {
        throw new Error('unused');
      },
      withdraw: async () => {
        throw new Error('unused');
      },
      changeManualRank: async () => {
        throw new Error('unused');
      },
    },
  );
  const command = {
    groupId: asGroupId('group-1'),
    gameId: asGameId('game-1'),
    userId: asUserId('user-1'),
    intent: 'CONFIRMED' as const,
    idempotencyKey: 'callback:42',
  };

  const result = await useCase.execute(command);

  expect(result).toMatchObject({ state: 'ROSTERED', rosterPosition: 1 });
  expect(calls).toEqual([{ ...command, membershipPriority: 1 }]);
});
