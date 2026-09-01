import { expect, it } from 'vitest';
import {
  asAttendanceSnapshotId,
  asGameId,
  asGroupId,
  asUserId,
  type AttendanceSnapshot,
} from '@volley/domain';
import { FinalizeSettlement } from './finalize-settlement.js';
import { PreviewSettlement } from './preview-settlement.js';
import type {
  LockedSettlementChanges,
  PaymentRepository,
  Settlement,
} from './ports.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const organizer = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');

it('persists one immutable charge per billable finalized attendee', async () => {
  const snapshots = finalizedAttendance(18);
  const saved: Settlement[] = [];
  const payments = memoryPayments(snapshots, saved);
  const finalize = new FinalizeSettlement(allowOrganizer, payments);

  const settlement = await finalize.execute({
    groupId,
    gameId,
    actorUserId: organizer,
    attendanceRevision: 1,
    totalAmount: '2800.00',
    currency: 'RUB',
    roundingMode: 'UP_10',
  });

  expect(settlement.charges).toHaveLength(18);
  expect(settlement.surplusMinor).toBe(8000n);
  expect(saved).toEqual([settlement]);
  expect(settlement.charges.map((charge) => charge.participantRef)).toEqual(
    snapshots.entries.map((entry) => entry.participantRef).toSorted(),
  );
});

it('keeps a manual billable attendee in preview and final charges', async () => {
  const snapshot = finalizedAttendance(1, true);
  const payments = memoryPayments(snapshot, []);
  const preview = new PreviewSettlement(allowOrganizer, payments);
  const finalize = new FinalizeSettlement(allowOrganizer, payments);
  const command = {
    groupId,
    gameId,
    actorUserId: organizer,
    attendanceRevision: 1,
    totalAmount: '100.00',
    currency: 'RUB' as const,
    roundingMode: 'EXACT' as const,
  };

  const draft = await preview.execute(command);
  const settlement = await finalize.execute(command);

  expect(draft.charges).toContainEqual(
    expect.objectContaining({
      participantRef: 'manual:late-player',
      displayName: 'Late player',
    }),
  );
  expect(settlement.charges).toContainEqual(
    expect.objectContaining({
      participantRef: 'manual:late-player',
      displayName: 'Late player',
      status: 'UNPAID',
    }),
  );
});

it('rejects an attendance revision that is not finalized', async () => {
  const snapshot = { ...finalizedAttendance(1), finalized: false };
  const finalize = new FinalizeSettlement(
    allowOrganizer,
    memoryPayments(snapshot, []),
  );

  await expect(
    finalize.execute({
      groupId,
      gameId,
      actorUserId: organizer,
      attendanceRevision: 1,
      totalAmount: '100',
      currency: 'RUB',
      roundingMode: 'EXACT',
    }),
  ).rejects.toThrow(/finalized attendance revision required/i);
});

const allowOrganizer = { requireOrganizer: async () => undefined };

const finalizedAttendance = (
  count: number,
  includeManual = false,
): AttendanceSnapshot => ({
  id: asAttendanceSnapshotId('018f6ba0-62d2-7bd1-8f13-12e0c8424699'),
  groupId,
  gameId,
  revision: 1,
  finalized: true,
  rosterCandidates: [],
  entries: [
    ...Array.from({ length: count }, (_, index) => ({
      participantRef: `registration:${index.toString().padStart(2, '0')}`,
      displayName: `Player ${index + 1}`,
      billable: true,
      addedManually: false,
    })),
    ...(includeManual
      ? [
          {
            participantRef: 'manual:late-player',
            displayName: 'Late player',
            billable: true,
            addedManually: true,
          },
        ]
      : []),
  ],
});

const memoryPayments = (
  snapshot: AttendanceSnapshot,
  saved: Settlement[],
): PaymentRepository => ({
  findFinalizedAttendance: async () => snapshot,
  withLockedFinalizedAttendance: async (
    _groupId,
    _gameId,
    _revision,
    callback,
  ) => {
    const changes: LockedSettlementChanges = {
      createRevision: async (input) => {
        const settlement: Settlement = {
          id: `settlement-${saved.length + 1}`,
          groupId,
          gameId,
          attendanceSnapshotId: snapshot.id,
          attendanceRevision: snapshot.revision,
          revision: saved.length + 1,
          totalMinor: input.totalMinor,
          currency: input.currency,
          roundingMode: input.roundingMode,
          allocationOrder: input.allocationOrder,
          collectedMinor: input.collectedMinor,
          surplusMinor: input.surplusMinor,
          supersededAt: null,
          createdBy: input.actorUserId,
          createdAt: new Date('2026-08-31T00:00:00Z'),
          charges: input.charges.map((charge, index) => ({
            id: `charge-${index + 1}`,
            settlementId: `settlement-${saved.length + 1}`,
            ...charge,
            privateReminderAvailable: !charge.addedManually,
            status: 'UNPAID',
            createdAt: new Date('2026-08-31T00:00:00Z'),
          })),
        };
        saved.push(settlement);
        return settlement;
      },
    };
    return callback(snapshot, changes);
  },
  finalizeDraft: async () => {
    throw new Error('unused');
  },
  changeChargeStatus: async () => {
    throw new Error('unused');
  },
  enqueueReminders: async () => {
    throw new Error('unused');
  },
});
