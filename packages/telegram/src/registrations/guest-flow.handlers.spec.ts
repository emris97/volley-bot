import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  asUserId,
} from '@volley/domain';
import { expect, it } from 'vitest';
import {
  GuestFlowHandlers,
  type GuestRegistrationDraft,
} from './guest-flow.handlers.js';
import { SignedStartToken } from '../signed-start-token.js';

it('resumes a signed guest-name flow and requires a nonblank name', async () => {
  let stored: GuestRegistrationDraft | null = null;
  const calls: unknown[] = [];
  const signer = new SignedStartToken('a-secret-with-at-least-32-characters');
  const gameId = asGameId('00000000-0000-4000-8000-000000000002');
  const inviterTelegramId = asTelegramId('42');
  const token = signer.sign({
    purpose: 'add-guest',
    gameId,
    inviterTelegramId,
    expiresAt: new Date('2026-09-01T12:15:00Z').toISOString(),
  });
  const drafts = {
    load: async () => stored,
    save: async (draft: GuestRegistrationDraft) => {
      stored = draft;
    },
    clear: async () => {
      stored = null;
    },
  };
  const createHandlers = () =>
    new GuestFlowHandlers(
      signer,
      drafts,
      {
        resolve: async () => ({
          groupId: asGroupId('group'),
          gameId,
          userId: asUserId('inviter'),
          activeRegistrationId: null,
        }),
      },
      {
        execute: async (command) => {
          calls.push(command);
          return {
            registrationId: asRegistrationId('guest-registration'),
            state: 'ROSTERED',
          };
        },
      },
    );

  await createHandlers().handleStart({
    telegramUserId: inviterTelegramId,
    token,
    now: new Date('2026-09-01T12:00:00Z'),
  });
  await expect(
    createHandlers().handleName({
      telegramUserId: inviterTelegramId,
      text: '   ',
      updateId: 10,
    }),
  ).rejects.toThrow(/guest name/i);
  await createHandlers().handleName({
    telegramUserId: inviterTelegramId,
    text: ' Alice ',
    updateId: 11,
  });

  expect(calls).toEqual([
    expect.objectContaining({
      gameId,
      inviterUserId: asUserId('inviter'),
      guestDisplayName: 'Alice',
      idempotencyKey: 'guest-name:11',
    }),
  ]);
  expect(stored).toBeNull();
});
