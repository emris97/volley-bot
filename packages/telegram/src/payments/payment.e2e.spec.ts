import { expect, it } from 'vitest';
import { asGameId, asGroupId, asTelegramId, asUserId } from '@volley/domain';
import { PaymentHandlers } from './payment.handlers.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const actorUserId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');
const telegramUserId = asTelegramId('42');

it('runs the private decimal preview, confirmation, controls, and selected reminder flow', async () => {
  const finalized: unknown[] = [];
  const statuses: unknown[] = [];
  const reminders: unknown[] = [];
  const previewResult = {
    attendanceRevision: 1,
    participantCount: 2,
    totalMinor: 280000n,
    collectedMinor: 280000n,
    surplusMinor: 0n,
    currency: 'RUB' as const,
    roundingMode: 'EXACT' as const,
    allocationOrder: ['manual:late-player', 'registration:player'],
    charges: [
      {
        participantRef: 'registration:player',
        displayName: 'Player',
        addedManually: false,
        amountMinor: 140000n,
      },
      {
        participantRef: 'manual:late-player',
        displayName: 'Late player',
        addedManually: true,
        amountMinor: 140000n,
      },
    ],
  };
  const settlement = {
    id: '018f6ba0-62d2-7bd1-8f13-12e0c8424690',
    groupId,
    gameId,
    attendanceSnapshotId: '018f6ba0-62d2-7bd1-8f13-12e0c8424699' as never,
    attendanceRevision: 1,
    revision: 1,
    totalMinor: 280000n,
    currency: 'RUB' as const,
    roundingMode: 'EXACT' as const,
    allocationOrder: ['manual:late-player', 'registration:player'],
    collectedMinor: 280000n,
    surplusMinor: 0n,
    supersededAt: null,
    createdBy: actorUserId,
    createdAt: new Date('2026-08-31T00:00:00Z'),
    charges: previewResult.charges.map((charge, index) => ({
      id: `018f6ba0-62d2-7bd1-8f13-12e0c84246${index + 1}`,
      settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424690',
      ...charge,
      status: 'UNPAID' as const,
      createdAt: new Date('2026-08-31T00:00:00Z'),
    })),
  };
  const handlers = new PaymentHandlers(
    {
      resolve: async () => ({ groupId, gameId, userId: actorUserId }),
    },
    { execute: async () => previewResult },
    {
      execute: async (command) => {
        finalized.push(command);
        return settlement;
      },
    },
    {
      execute: async (command) => {
        statuses.push(command);
        return { ...settlement.charges[0]!, status: command.status };
      },
    },
    {
      execute: async (command) => {
        reminders.push(command);
        return { enqueued: command.chargeIds.length };
      },
    },
  );

  expect(
    handlers.start({ telegramUserId, gameId, privateChat: true }),
  ).toMatchObject({ text: expect.stringMatching(/сумм.*руб/i) });
  const preview = await handlers.preview({
    telegramUserId,
    gameId,
    privateChat: true,
    attendanceRevision: 1,
    totalAmount: '2800.00',
    currency: 'RUB',
    roundingMode: 'EXACT',
  });
  expect(preview.text).toMatch(/2 участник/i);
  expect(preview.text).toMatch(/Late player/);
  expect(preview.text).toMatch(/2800\.00/);

  const confirmed = await handlers.confirm({
    telegramUserId,
    gameId,
    privateChat: true,
    attendanceRevision: 1,
    totalAmount: '2800.00',
    currency: 'RUB',
    roundingMode: 'EXACT',
  });
  expect(confirmed.buttons.map((button) => button.text)).toEqual(
    expect.arrayContaining(['Оплачено', 'Не оплачено', 'Оплата не требуется']),
  );

  await handlers.changeStatus({
    telegramUserId,
    gameId,
    privateChat: true,
    chargeId: settlement.charges[0]!.id,
    status: 'PAID',
  });
  await handlers.sendReminders({
    telegramUserId,
    gameId,
    privateChat: true,
    chargeIds: [settlement.charges[0]!.id],
  });

  expect(finalized).toHaveLength(1);
  expect(statuses).toHaveLength(1);
  expect(reminders).toHaveLength(1);
});

it('rejects payment management outside a private chat', async () => {
  const handlers = new PaymentHandlers(
    { resolve: async () => ({ groupId, gameId, userId: actorUserId }) },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
    {
      execute: async () => {
        throw new Error('unused');
      },
    },
  );

  await expect(
    handlers.preview({
      telegramUserId,
      gameId,
      privateChat: false,
      attendanceRevision: 1,
      totalAmount: '100',
      currency: 'RUB',
      roundingMode: 'EXACT',
    }),
  ).rejects.toThrow(/private chat required/i);
});
