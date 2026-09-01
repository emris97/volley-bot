import type { PaymentDraft, PaymentDraftRepository } from '@volley/application';
import { asGameId, asGroupId, asTelegramId, asUserId } from '@volley/domain';
import { expect, it, vi } from 'vitest';
import {
  PaymentHandlers,
  registerPaymentHandlers,
} from './payment.handlers.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const actorUserId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');
const telegramUserId = asTelegramId('42');
const draftId = '018f6ba0-62d2-7bd1-8f13-12e0c8424688';

interface TestCallbackContext {
  callbackQuery: {
    from: { id: number };
    data: string;
    message: { chat: { type: string } };
  };
  editMessageText: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}

it('drives restart-safe confirmation, status, and reminder callbacks through fresh handlers', async () => {
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
      id: [
        '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
        '018f6ba0-62d2-7bd1-8f13-12e0c8424622',
      ][index]!,
      settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424690',
      ...charge,
      status: 'UNPAID' as const,
      createdAt: new Date('2026-08-31T00:00:00Z'),
    })),
  };
  let storedDraft: PaymentDraft | null = null;
  const drafts: PaymentDraftRepository = {
    saveDraft: async (input) => {
      storedDraft = {
        id: draftId,
        ...input,
        expiresAt: new Date('2026-08-31T01:00:00Z'),
      };
      return storedDraft;
    },
    findDraft: async (requestedGroupId, requestedDraftId) =>
      storedDraft?.groupId === requestedGroupId &&
      storedDraft.id === requestedDraftId
        ? storedDraft
        : null,
    deleteDraft: async (requestedGroupId, requestedDraftId) => {
      if (
        storedDraft?.groupId === requestedGroupId &&
        storedDraft.id === requestedDraftId
      ) {
        storedDraft = null;
      }
    },
  };
  const createHandlers = () =>
    new PaymentHandlers(
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
          return { ...settlement.charges[1]!, status: command.status };
        },
      },
      {
        execute: async (command) => {
          reminders.push(command);
          return { enqueued: command.chargeIds.length };
        },
      },
      drafts,
    );

  const preview = await createHandlers().preview({
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
  const confirmData = preview.buttons.find(
    (button) => button.text === 'Подтвердить',
  )!.callbackData;
  expect(Buffer.byteLength(confirmData, 'utf8')).toBeLessThanOrEqual(64);

  const confirmed = await createHandlers().handleCallback({
    telegramUserId,
    privateChat: true,
    data: confirmData,
  });
  expect(confirmed.buttons.map((button) => button.text)).toEqual(
    expect.arrayContaining([
      'Оплачено',
      'Не оплачено',
      'Оплата не требуется',
      'Напомнить',
    ]),
  );
  expect(
    confirmed.buttons.every(
      (button) => Buffer.byteLength(button.callbackData, 'utf8') <= 64,
    ),
  ).toBe(true);

  const paidData = confirmed.buttons.filter(
    (button) => button.text === 'Оплачено',
  )[1]!.callbackData;
  await createHandlers().handleCallback({
    telegramUserId,
    privateChat: true,
    data: paidData,
  });
  const reminderData = confirmed.buttons.find(
    (button) => button.text === 'Напомнить',
  )!.callbackData;
  await createHandlers().handleCallback({
    telegramUserId,
    privateChat: true,
    data: reminderData,
  });

  expect(finalized).toEqual([
    expect.objectContaining({
      groupId,
      gameId,
      actorUserId,
      attendanceRevision: 1,
      totalAmount: '2800.00',
      roundingMode: 'EXACT',
    }),
  ]);
  expect(statuses).toEqual([
    expect.objectContaining({
      groupId,
      actorUserId,
      chargeId: settlement.charges[1]!.id,
      status: 'PAID',
    }),
  ]);
  expect(reminders).toEqual([
    { groupId, actorUserId, chargeIds: [settlement.charges[0]!.id] },
  ]);
});

it('registers payment callbacks and rejects callback updates outside a private chat', async () => {
  const externalCalls: unknown[] = [];
  let registered:
    | {
        pattern: RegExp;
        handler: (context: TestCallbackContext) => Promise<void>;
      }
    | undefined;
  const bot = {
    callbackQuery: (
      pattern: RegExp,
      handler: (context: TestCallbackContext) => Promise<void>,
    ) => {
      registered = { pattern, handler };
    },
  };
  const handlers = new PaymentHandlers(
    {
      resolve: async () => {
        externalCalls.push('resolve');
        return { groupId, gameId, userId: actorUserId };
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
    {
      execute: async (command) => {
        externalCalls.push(command);
        return { enqueued: command.chargeIds.length };
      },
    },
    {
      saveDraft: async () => {
        throw new Error('unused');
      },
      findDraft: async () => {
        throw new Error('unused');
      },
      deleteDraft: async () => {
        throw new Error('unused');
      },
    },
  );
  registerPaymentHandlers(bot as never, handlers);
  expect(registered?.pattern.test('pay:r:bad')).toBe(true);

  await expect(
    registered!.handler({
      callbackQuery: {
        from: { id: Number(telegramUserId) },
        data: 'pay:r:bad',
        message: { chat: { type: 'supergroup' } },
      },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    }),
  ).rejects.toThrow(/private chat required/i);
  expect(externalCalls).toEqual([]);

  const editMessageText = vi.fn().mockResolvedValue(undefined);
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const chargeId = '018f6ba0-62d2-7bd1-8f13-12e0c8424621';
  await registered!.handler({
    callbackQuery: {
      from: { id: Number(telegramUserId) },
      data: `pay:r:${compactUuid(gameId)}:${compactUuid(chargeId)}`,
      message: { chat: { type: 'private' } },
    },
    editMessageText,
    answerCallbackQuery,
  });
  expect(externalCalls).toEqual([
    'resolve',
    { groupId, actorUserId, chargeIds: [chargeId] },
  ]);
  expect(editMessageText).toHaveBeenCalledOnce();
  expect(answerCallbackQuery).toHaveBeenCalledOnce();
});

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');
