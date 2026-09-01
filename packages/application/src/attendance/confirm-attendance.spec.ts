import { describe, expect, it } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asUserId,
  type AttendanceSnapshot,
  type GameState,
} from '@volley/domain';
import {
  ConfirmAttendance,
  type AttendanceRepository,
} from './confirm-attendance.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const completedGame = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const openGame = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424612');
const organizer = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');
const absentRegistrationId = asRegistrationId(
  '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
);

describe('ConfirmAttendance', () => {
  it('starts from the final roster and permits explicit corrections', async () => {
    const useCase = new ConfirmAttendance(
      { requireOrganizer: async () => undefined },
      new InMemoryAttendanceRepository('COMPLETED'),
    );

    const snapshot = await useCase.execute({
      groupId,
      gameId: completedGame,
      actorUserId: organizer,
      expectedRevision: 0,
      excludedRegistrationIds: [absentRegistrationId],
      manualParticipants: [{ displayName: 'Late player', billable: true }],
      finalize: false,
    });

    expect(
      snapshot.entries.some(
        (entry) => entry.sourceRegistrationId === absentRegistrationId,
      ),
    ).toBe(false);
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({ displayName: 'Late player' }),
    );
  });

  it('rejects attendance confirmation before completion', async () => {
    const useCase = new ConfirmAttendance(
      { requireOrganizer: async () => undefined },
      new InMemoryAttendanceRepository('OPEN'),
    );

    await expect(
      useCase.execute({
        groupId,
        gameId: openGame,
        actorUserId: organizer,
        expectedRevision: 0,
        excludedRegistrationIds: [],
        manualParticipants: [],
        finalize: false,
      }),
    ).rejects.toThrow(/game must be completed/i);
  });
});

class InMemoryAttendanceRepository implements AttendanceRepository {
  public constructor(private readonly state: GameState) {}

  public async confirm(input: {
    groupId: typeof groupId;
    gameId: typeof completedGame;
    actorUserId: typeof organizer;
    expectedRevision: number;
    excludedRegistrationIds: readonly (typeof absentRegistrationId)[];
    manualParticipants: readonly { displayName: string; billable: boolean }[];
    finalize: boolean;
  }): Promise<AttendanceSnapshot> {
    if (this.state !== 'COMPLETED') throw new Error('Game must be completed');
    const roster = [
      {
        participantRef: `registration:${absentRegistrationId}`,
        sourceRegistrationId: absentRegistrationId,
        displayName: 'Absent player',
        billable: true,
        addedManually: false,
      },
      {
        participantRef: 'registration:present',
        sourceRegistrationId: asRegistrationId(
          '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
        ),
        displayName: 'Present player',
        billable: true,
        addedManually: false,
      },
    ];
    return {
      groupId: input.groupId,
      gameId: input.gameId,
      revision: input.expectedRevision + 1,
      finalized: input.finalize,
      entries: [
        ...roster.filter(
          (entry) =>
            !input.excludedRegistrationIds.includes(entry.sourceRegistrationId),
        ),
        ...input.manualParticipants.map((participant, index) => ({
          participantRef: `manual:${index}`,
          displayName: participant.displayName,
          billable: participant.billable,
          addedManually: true,
        })),
      ],
    };
  }
}
