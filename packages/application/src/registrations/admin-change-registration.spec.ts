import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asUserId,
} from '@volley/domain';
import { expect, it } from 'vitest';
import { AdminChangeRegistration } from './admin-change-registration.js';

it('authorizes an organizer before requesting an administrative cancellation', async () => {
  const calls: unknown[] = [];
  const command = {
    groupId: asGroupId('group'),
    gameId: asGameId('game'),
    registrationId: asRegistrationId('registration'),
    actorUserId: asUserId('organizer'),
    action: 'CANCEL' as const,
    reason: 'Roster correction',
  };
  const useCase = new AdminChangeRegistration(
    { requireOrganizer: async () => undefined },
    {
      registerParticipant: async () => {
        throw new Error('unused');
      },
      registerGuest: async () => {
        throw new Error('unused');
      },
      withdraw: async (input) => {
        calls.push(input);
        return { registrationId: command.registrationId, state: 'CANCELLED' };
      },
      changeManualRank: async () => {
        throw new Error('unused');
      },
    },
  );

  await useCase.execute(command);

  expect(calls).toEqual([
    expect.objectContaining({ allowOrganizerOverride: true }),
  ]);
});

it('adds a named participant through the same guest registration path', async () => {
  const calls: unknown[] = [];
  const useCase = new AdminChangeRegistration(
    { requireOrganizer: async () => undefined },
    {
      registerParticipant: async () => {
        throw new Error('unused');
      },
      registerGuest: async (input) => {
        calls.push(input);
        return {
          registrationId: asRegistrationId('added'),
          state: 'ROSTERED',
        };
      },
      withdraw: async () => {
        throw new Error('unused');
      },
      changeManualRank: async () => {
        throw new Error('unused');
      },
    },
  );

  await useCase.execute({
    groupId: asGroupId('group'),
    gameId: asGameId('game'),
    actorUserId: asUserId('organizer'),
    action: 'ADD_NAMED',
    guestDisplayName: 'Late player',
    idempotencyKey: 'admin:add:1',
    reason: 'Attended without registration',
  });

  expect(calls).toEqual([
    expect.objectContaining({
      inviterUserId: asUserId('organizer'),
      guestDisplayName: 'Late player',
    }),
  ]);
});
