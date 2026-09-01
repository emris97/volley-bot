import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  asUserId,
} from '@volley/domain';
import { expect, it } from 'vitest';
import { CallbackCodec } from '../callbacks/callback-codec.js';
import { RegistrationHandlers } from './registration.handlers.js';

it('registers the callback sender for the referenced game only', async () => {
  const codec = new CallbackCodec();
  const gameA = asGameId('123e4567-e89b-12d3-a456-426614174001');
  const gameB = asGameId('123e4567-e89b-12d3-a456-426614174002');
  const calls: unknown[] = [];
  const handlers = new RegistrationHandlers(
    codec,
    {
      resolve: async (gameId, telegramUserId) => ({
        groupId: asGroupId('group-a'),
        gameId,
        userId: asUserId(`user:${telegramUserId}`),
        activeRegistrationId: null,
      }),
    },
    {
      execute: async (command) => {
        calls.push(command);
        return {
          registrationId: asRegistrationId('registration-a'),
          state: 'ROSTERED',
          rosterPosition: 1,
        };
      },
    },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
  );

  const text = await handlers.handleCallback({
    telegramUserId: asTelegramId('42'),
    updateId: 99,
    data: codec.going(gameA),
  });

  expect(text).toBe('registration:rostered:1');
  expect(calls).toEqual([
    expect.objectContaining({
      gameId: gameA,
      idempotencyKey: 'callback:99',
      intent: 'CONFIRMED',
    }),
  ]);
  expect(calls).not.toEqual([expect.objectContaining({ gameId: gameB })]);
});
