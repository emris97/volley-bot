import { expect, it } from 'vitest';
import { asGroupId, asUserId } from '@volley/domain';
import { ChangeChargeStatus } from './change-charge-status.js';
import { SendPaymentReminders } from './send-payment-reminders.js';
import type { PaymentRepository } from './ports.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const organizer = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');
const participant = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424614');
const chargeId = '018f6ba0-62d2-7bd1-8f13-12e0c8424620';

it('does not let a participant mark their own charge paid', async () => {
  const changeStatus = new ChangeChargeStatus(denyParticipant, unusedPayments);

  await expect(
    changeStatus.execute({
      groupId,
      chargeId,
      actorUserId: participant,
      status: 'PAID',
    }),
  ).rejects.toThrow(/organizer permission required/i);
});

it('records an organizer status change through the tenant-scoped repository', async () => {
  const calls: unknown[] = [];
  const changeStatus = new ChangeChargeStatus(allowOrganizer, {
    ...unusedPayments,
    changeChargeStatus: async (input) => {
      calls.push(input);
      return {
        id: input.chargeId,
        settlementId: 'settlement-1',
        participantRef: 'registration:1',
        displayName: 'Player',
        addedManually: false,
        amountMinor: 10000n,
        status: input.status,
        createdAt: new Date('2026-08-31T00:00:00Z'),
      };
    },
  });

  await changeStatus.execute({
    groupId,
    chargeId,
    actorUserId: organizer,
    status: 'WAIVED',
  });

  expect(calls).toEqual([
    { groupId, chargeId, actorUserId: organizer, status: 'WAIVED' },
  ]);
});

it('enqueues selected private reminders only after organizer authorization', async () => {
  const calls: unknown[] = [];
  const reminders = new SendPaymentReminders(allowOrganizer, {
    ...unusedPayments,
    enqueueReminders: async (input) => {
      calls.push(input);
      return { enqueued: input.chargeIds.length };
    },
  });

  await expect(
    reminders.execute({
      groupId,
      actorUserId: organizer,
      chargeIds: ['charge-2', 'charge-1'],
    }),
  ).resolves.toEqual({ enqueued: 2 });
  expect(calls).toEqual([
    {
      groupId,
      actorUserId: organizer,
      chargeIds: ['charge-2', 'charge-1'],
    },
  ]);
});

const allowOrganizer = { requireOrganizer: async () => undefined };
const denyParticipant = {
  requireOrganizer: async () => {
    throw new Error('Organizer permission required');
  },
};
const unusedPayments: PaymentRepository = {
  findFinalizedAttendance: async () => null,
  withLockedFinalizedAttendance: async () => {
    throw new Error('unused');
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
};
