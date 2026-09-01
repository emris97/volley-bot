import type {
  PaymentDraft,
  PaymentInputSession,
  Settlement,
  PaymentTelegramRepository,
} from '@volley/application';
import { asGameId, asGroupId, asTelegramId, asUserId } from '@volley/domain';
import type { Update, UserFromGetMe } from 'grammy/types';
import { expect, it, vi } from 'vitest';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
} from '../bot.factory.js';
import {
  PaymentHandlers,
  registerPaymentHandlers,
} from './payment.handlers.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const actorUserId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');
const telegramUserId = asTelegramId('42');
const draftId = '018f6ba0-62d2-7bd1-8f13-12e0c8424688';
const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Volley',
  username: 'volley_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

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
  let activeSettlement: Settlement = settlement;
  let storedDraft: PaymentDraft | null = null;
  const drafts: PaymentTelegramRepository = {
    saveDraft: async (input) => {
      storedDraft = {
        id: draftId,
        ...input,
        expiresAt: new Date('2026-08-31T01:00:00Z'),
        finalizedSettlementId: null,
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
    findActiveSettlement: async () => activeSettlement,
    beginInput: async () => {
      throw new Error('unused');
    },
    findInputByTelegramUserId: async () => null,
    clearInput: async () => undefined,
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
          const changed = {
            ...activeSettlement.charges[1]!,
            status: command.status,
          };
          activeSettlement = {
            ...activeSettlement,
            charges: [activeSettlement.charges[0]!, changed],
          };
          return changed;
        },
      },
      {
        execute: async (command) => {
          reminders.push(command);
          return { enqueued: command.chargeIds.length };
        },
      },
      drafts,
      { requireOrganizer: async () => undefined },
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
  const afterPaid = await createHandlers().handleCallback({
    telegramUserId,
    privateChat: true,
    data: paidData,
  });
  expect(afterPaid.buttons.map((button) => button.text)).toEqual(
    expect.arrayContaining([
      'Оплачено',
      'Не оплачено',
      'Оплата не требуется',
      'Напомнить',
    ]),
  );
  const reminderData = afterPaid.buttons.find(
    (button) => button.text === 'Напомнить',
  )!.callbackData;
  const afterReminder = await createHandlers().handleCallback({
    telegramUserId,
    privateChat: true,
    data: reminderData,
  });
  expect(afterReminder.buttons.map((button) => button.text)).toEqual(
    expect.arrayContaining([
      'Оплачено',
      'Не оплачено',
      'Оплата не требуется',
      'Напомнить',
    ]),
  );

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
  const activeSettlement: Settlement = {
    id: '018f6ba0-62d2-7bd1-8f13-12e0c8424690',
    groupId,
    gameId,
    attendanceSnapshotId: '018f6ba0-62d2-7bd1-8f13-12e0c8424699' as never,
    attendanceRevision: 1,
    revision: 1,
    totalMinor: 10000n,
    currency: 'RUB',
    roundingMode: 'EXACT',
    allocationOrder: ['registration:player'],
    collectedMinor: 10000n,
    surplusMinor: 0n,
    supersededAt: null,
    createdBy: actorUserId,
    createdAt: new Date('2026-08-31T00:00:00Z'),
    charges: [
      {
        id: '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
        settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424690',
        participantRef: 'registration:player',
        displayName: 'Player',
        addedManually: false,
        amountMinor: 10000n,
        status: 'UNPAID',
        createdAt: new Date('2026-08-31T00:00:00Z'),
      },
    ],
  };
  let registered:
    | {
        pattern: RegExp;
        handler: (context: TestCallbackContext) => Promise<void>;
      }
    | undefined;
  const bot = {
    command: () => undefined,
    on: () => undefined,
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
      beginInput: async () => {
        throw new Error('unused');
      },
      findInputByTelegramUserId: async () => null,
      clearInput: async () => undefined,
      findActiveSettlement: async () => activeSettlement,
    },
    { requireOrganizer: async () => undefined },
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

it('runs registered private payment command through durable decimal input and fresh confirmation', async () => {
  const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> =
    [];
  const finalized: unknown[] = [];
  let inputSession: PaymentInputSession | null = null;
  let draft: PaymentDraft | null = null;
  const previewResult = {
    attendanceRevision: 1,
    participantCount: 1,
    totalMinor: 10000n,
    collectedMinor: 10000n,
    surplusMinor: 0n,
    currency: 'RUB' as const,
    roundingMode: 'EXACT' as const,
    allocationOrder: ['registration:player'],
    charges: [
      {
        participantRef: 'registration:player',
        displayName: 'Player',
        addedManually: false,
        amountMinor: 10000n,
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
    totalMinor: 10000n,
    currency: 'RUB' as const,
    roundingMode: 'EXACT' as const,
    allocationOrder: ['registration:player'],
    collectedMinor: 10000n,
    surplusMinor: 0n,
    supersededAt: null,
    createdBy: actorUserId,
    createdAt: new Date('2026-08-31T00:00:00Z'),
    charges: [
      {
        id: '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
        settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424690',
        ...previewResult.charges[0]!,
        status: 'UNPAID' as const,
        createdAt: new Date('2026-08-31T00:00:00Z'),
      },
    ],
  };
  const state: PaymentTelegramRepository = {
    beginInput: async (input) => {
      inputSession = {
        ...input,
        attendanceRevision: 1,
        currency: 'RUB',
        roundingMode: 'EXACT',
        expiresAt: new Date('2026-08-31T01:00:00Z'),
      };
      return inputSession;
    },
    findInputByTelegramUserId: async (id) =>
      id === telegramUserId ? inputSession : null,
    clearInput: async () => {
      inputSession = null;
    },
    saveDraft: async (input) => {
      draft = {
        id: draftId,
        ...input,
        expiresAt: new Date('2026-08-31T01:00:00Z'),
        finalizedSettlementId: null,
      };
      return draft;
    },
    findDraft: async (_groupId, requestedDraftId) =>
      draft?.id === requestedDraftId ? draft : null,
    deleteDraft: async () => undefined,
    findActiveSettlement: async () => settlement,
  };
  const createOperationalBot = () => {
    const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', botInfo);
    registerPaymentHandlers(
      bot,
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
          execute: async () => {
            throw new Error('unused');
          },
        },
        {
          execute: async () => {
            throw new Error('unused');
          },
        },
        state,
        { requireOrganizer: async () => undefined },
      ),
    );
    bot.api.config.use(async (_previous, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      return {
        ok: true,
        result:
          method === 'answerCallbackQuery'
            ? true
            : {
                message_id: 100,
                date: 1_788_134_400,
                chat: { id: Number(telegramUserId), type: 'private' },
                text: 'ok',
              },
      } as never;
    });
    return createLazyTelegramUpdateHandler(bot);
  };

  await createOperationalBot().handleUpdate(paymentCommandUpdate(1));
  expect(apiCalls.at(-1)).toMatchObject({
    method: 'sendMessage',
    payload: { text: expect.stringMatching(/сумм.*руб/i) },
  });

  await createOperationalBot().handleUpdate(paymentAmountUpdate(2, '100.00'));
  const previewCall = apiCalls.at(-1)!;
  expect(previewCall).toMatchObject({
    method: 'sendMessage',
    payload: { text: expect.stringMatching(/предпросмотр/i) },
  });
  const keyboard = (
    previewCall.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    }
  ).inline_keyboard;
  const confirmData = keyboard[0]![0]!.callback_data;

  await createOperationalBot().handleUpdate(
    paymentCallbackUpdate(3, confirmData),
  );
  expect(apiCalls.at(-2)).toMatchObject({
    method: 'editMessageText',
    payload: { text: expect.stringMatching(/расчёт #1/i) },
  });
  expect(finalized).toEqual([
    expect.objectContaining({
      groupId,
      gameId,
      actorUserId,
      draftId,
      totalAmount: '100.00',
    }),
  ]);
});

it('passes ordinary group text to later middleware while private payment input remains active', async () => {
  const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> =
    [];
  const nextMiddleware = vi.fn();
  const session: PaymentInputSession = {
    groupId,
    gameId,
    actorUserId,
    attendanceRevision: 1,
    currency: 'RUB',
    roundingMode: 'EXACT',
    expiresAt: new Date('2026-08-31T01:00:00Z'),
  };
  const state: PaymentTelegramRepository = {
    beginInput: async () => session,
    findInputByTelegramUserId: async () => session,
    clearInput: async () => undefined,
    saveDraft: async (input) => ({
      id: draftId,
      ...input,
      expiresAt: new Date('2026-08-31T01:00:00Z'),
      finalizedSettlementId: null,
    }),
    findDraft: async () => null,
    deleteDraft: async () => undefined,
    findActiveSettlement: async () => null,
  };
  const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', botInfo);
  registerPaymentHandlers(
    bot,
    new PaymentHandlers(
      {
        resolve: async () => ({ groupId, gameId, userId: actorUserId }),
      },
      {
        execute: async () => ({
          attendanceRevision: 1,
          participantCount: 1,
          totalMinor: 10000n,
          collectedMinor: 10000n,
          surplusMinor: 0n,
          currency: 'RUB',
          roundingMode: 'EXACT',
          allocationOrder: ['registration:player'],
          charges: [
            {
              participantRef: 'registration:player',
              displayName: 'Player',
              addedManually: false,
              amountMinor: 10000n,
            },
          ],
        }),
      },
      { execute: async () => Promise.reject(new Error('unused')) },
      { execute: async () => Promise.reject(new Error('unused')) },
      { execute: async () => Promise.reject(new Error('unused')) },
      state,
      { requireOrganizer: async () => undefined },
    ),
  );
  bot.on('message:text', () => {
    nextMiddleware();
  });
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result: {
        message_id: 100,
        date: 1_788_134_400,
        chat: { id: Number(telegramUserId), type: 'private' },
        text: 'ok',
      },
    } as never;
  });
  const updates = createLazyTelegramUpdateHandler(bot);

  await expect(
    updates.handleUpdate(paymentAmountUpdate(4, 'обычное сообщение', 'group')),
  ).resolves.toBeUndefined();
  expect(nextMiddleware).toHaveBeenCalledOnce();
  expect(apiCalls).toEqual([]);

  await updates.handleUpdate(paymentAmountUpdate(5, '100.00'));
  expect(apiCalls.at(-1)).toMatchObject({
    method: 'sendMessage',
    payload: { text: expect.stringMatching(/предпросмотр/i) },
  });
});

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');

const paymentCommandUpdate = (updateId: number): Update => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat: { id: Number(telegramUserId), type: 'private', first_name: 'Admin' },
    from: { id: Number(telegramUserId), is_bot: false, first_name: 'Admin' },
    text: `/payment ${gameId}`,
    entities: [{ offset: 0, length: 8, type: 'bot_command' }],
  },
});

const paymentAmountUpdate = (
  updateId: number,
  text: string,
  chatType: 'private' | 'group' = 'private',
): Update => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat:
      chatType === 'private'
        ? { id: Number(telegramUserId), type: 'private', first_name: 'Admin' }
        : { id: -100, type: 'group', title: 'Volley' },
    from: { id: Number(telegramUserId), is_bot: false, first_name: 'Admin' },
    text,
  },
});

const paymentCallbackUpdate = (updateId: number, data: string): Update => ({
  update_id: updateId,
  callback_query: {
    id: String(updateId),
    chat_instance: 'test',
    from: { id: Number(telegramUserId), is_bot: false, first_name: 'Admin' },
    data,
    message: {
      message_id: updateId,
      date: 1_788_134_400,
      chat: {
        id: Number(telegramUserId),
        type: 'private',
        first_name: 'Admin',
      },
      text: 'preview',
    },
  },
});
