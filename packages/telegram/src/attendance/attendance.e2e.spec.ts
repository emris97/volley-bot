import { expect, it } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  asUserId,
  type AttendanceSnapshot,
} from '@volley/domain';
import { AttendanceHandlers } from './attendance.handlers.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const registrationId = asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424620');

it('toggles an excluded roster member back in and finalizes through callback data', async () => {
  const calls: Array<{
    excludedRegistrationIds: readonly (typeof registrationId)[];
    finalize: boolean;
  }> = [];
  const handlers = new AttendanceHandlers(
    {
      resolve: async () => ({
        groupId,
        gameId,
        userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613'),
      }),
    },
    {
      execute: async (command): Promise<AttendanceSnapshot> => {
        calls.push({
          excludedRegistrationIds: command.excludedRegistrationIds,
          finalize: command.finalize,
        });
        const excluded =
          command.excludedRegistrationIds.includes(registrationId);
        return {
          groupId: command.groupId,
          gameId: command.gameId,
          revision: command.expectedRevision + 1,
          finalized: command.finalize,
          rosterCandidates: [
            {
              participantRef: `registration:${registrationId}`,
              sourceRegistrationId: registrationId,
              displayName: 'Absent player',
              billable: true,
              included: !excluded,
            },
          ],
          entries: excluded
            ? []
            : [
                {
                  participantRef: `registration:${registrationId}`,
                  sourceRegistrationId: registrationId,
                  displayName: 'Absent player',
                  billable: true,
                  addedManually: false,
                },
              ],
        };
      },
    },
  );

  const preview = await handlers.preview({
    telegramUserId: asTelegramId('42'),
    gameId,
    expectedRevision: 0,
    excludedRegistrationIds: [registrationId],
    manualParticipants: [],
  });
  const rendered = handlers.render(preview);
  const toggle = rendered.buttons.find((button) =>
    button.callbackData.startsWith('at:t:'),
  );
  expect(toggle).toBeDefined();

  const corrected = await handlers.handleCallback({
    telegramUserId: asTelegramId('42'),
    data: toggle!.callbackData,
  });
  expect(corrected.snapshot.entries).toContainEqual(
    expect.objectContaining({ sourceRegistrationId: registrationId }),
  );
  expect(calls[1]).toMatchObject({
    excludedRegistrationIds: [],
    finalize: false,
  });

  const confirm = corrected.buttons.find((button) =>
    button.callbackData.startsWith('at:c:'),
  );
  expect(confirm).toBeDefined();
  const final = await handlers.handleCallback({
    telegramUserId: asTelegramId('42'),
    data: confirm!.callbackData,
  });

  expect(final.snapshot.finalized).toBe(true);
  expect(calls[2]).toMatchObject({
    excludedRegistrationIds: [],
    finalize: true,
  });
});
