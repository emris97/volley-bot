import { expect, it } from 'vitest';
import type { ConfirmAttendanceCommand } from '@volley/application';
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
  const snapshots = new Map<string, AttendanceSnapshot>();
  const attendance = {
    execute: async (
      command: ConfirmAttendanceCommand,
    ): Promise<AttendanceSnapshot> => {
      calls.push({
        excludedRegistrationIds: command.excludedRegistrationIds,
        finalize: command.finalize,
      });
      const excluded = command.excludedRegistrationIds.includes(registrationId);
      return {
        id: `018f6ba0-62d2-7bd1-8f13-12e0c84246${command.expectedRevision.toString().padStart(2, '0')}` as never,
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
  };
  const actors = {
    resolve: async () => ({
      groupId,
      gameId,
      userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613'),
    }),
  };
  const reader = {
    findSnapshot: async (_groupId: typeof groupId, snapshotId: string) =>
      snapshots.get(snapshotId) ?? null,
  };
  const firstHandlers = new AttendanceHandlers(actors, attendance, reader);
  const preview = await firstHandlers.preview({
    telegramUserId: asTelegramId('42'),
    gameId,
    expectedRevision: 0,
    excludedRegistrationIds: [registrationId],
    manualParticipants: [],
  });
  snapshots.set(preview.id, preview);
  const rendered = firstHandlers.render(preview);
  const toggle = rendered.buttons.find((button) =>
    button.callbackData.startsWith('at:t:'),
  );
  expect(toggle).toBeDefined();

  const freshHandlers = new AttendanceHandlers(actors, attendance, reader);
  const corrected = await freshHandlers.handleCallback({
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
  snapshots.set(corrected.snapshot.id, corrected.snapshot);
  const final = await freshHandlers.handleCallback({
    telegramUserId: asTelegramId('42'),
    data: confirm!.callbackData,
  });

  expect(final.snapshot.finalized).toBe(true);
  expect(calls[2]).toMatchObject({
    excludedRegistrationIds: [],
    finalize: true,
  });
});

it('rejects malformed and unknown compact attendance callbacks', async () => {
  const handlers = new AttendanceHandlers(
    {
      resolve: async () => ({ groupId, gameId, userId: asUserId('organizer') }),
    },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
    { findSnapshot: async () => null },
  );

  await expect(
    handlers.handleCallback({
      telegramUserId: asTelegramId('42'),
      data: 'at:t:bad',
    }),
  ).rejects.toThrow(/invalid attendance callback/i);
  await expect(
    handlers.handleCallback({
      telegramUserId: asTelegramId('42'),
      data: `at:c:${compactUuid('018f6ba0-62d2-7bd1-8f13-12e0c8424611')}:${compactUuid('018f6ba0-62d2-7bd1-8f13-12e0c8424610')}`,
    }),
  ).rejects.toThrow(/attendance preview not found/i);
});

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');
