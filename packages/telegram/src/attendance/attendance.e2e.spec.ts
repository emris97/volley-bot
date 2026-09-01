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
import type { Update, UserFromGetMe } from 'grammy/types';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
} from '../bot.factory.js';
import {
  AttendanceHandlers,
  registerAttendanceHandlers,
} from './attendance.handlers.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const registrationId = asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424620');
const secondRegistrationId = asRegistrationId(
  '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
);

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
          {
            participantRef: `registration:${secondRegistrationId}`,
            sourceRegistrationId: secondRegistrationId,
            displayName: 'Present player',
            billable: true,
            included: true,
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
  expect(corrected.snapshot.rosterCandidates[0]).toMatchObject({
    sourceRegistrationId: registrationId,
    included: true,
  });
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

it('adds a named manual participant through the registered private Telegram flow', async () => {
  const snapshots = new Map<string, AttendanceSnapshot>();
  const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> =
    [];
  const attendance = {
    execute: async (
      command: ConfirmAttendanceCommand,
    ): Promise<AttendanceSnapshot> => {
      const id =
        `018f6ba0-62d2-7bd1-8f13-12e0c84246${(command.expectedRevision + 1).toString().padStart(2, '0')}` as never;
      const snapshot: AttendanceSnapshot = {
        id,
        groupId: command.groupId,
        gameId: command.gameId,
        revision: command.expectedRevision + 1,
        finalized: command.finalize,
        rosterCandidates: [
          {
            participantRef: `registration:${registrationId}`,
            sourceRegistrationId: registrationId,
            displayName: 'Roster player',
            billable: true,
            included: true,
          },
        ],
        entries: [
          {
            participantRef: `registration:${registrationId}`,
            sourceRegistrationId: registrationId,
            displayName: 'Roster player',
            billable: true,
            addedManually: false,
          },
          ...command.manualParticipants.map((participant, index) => ({
            participantRef:
              participant.participantRef ??
              `manual:018f6ba0-62d2-7bd1-8f13-12e0c84246${index.toString().padStart(2, '0')}`,
            displayName: participant.displayName,
            billable: participant.billable,
            addedManually: true,
          })),
        ],
      };
      snapshots.set(snapshot.id, snapshot);
      return snapshot;
    },
  };
  const handlers = new AttendanceHandlers(
    {
      resolve: async () => ({
        groupId,
        gameId,
        userId: asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613'),
      }),
    },
    attendance,
    {
      findSnapshot: async (_requestedGroupId, snapshotId) =>
        snapshots.get(snapshotId) ?? null,
    },
  );
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
  const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', botInfo);
  registerAttendanceHandlers(bot, handlers);
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result:
        method === 'answerCallbackQuery'
          ? true
          : {
              message_id: apiCalls.length,
              date: 1_788_134_400,
              chat: { id: 42, type: 'private' },
              text: String((payload as { text?: unknown }).text ?? 'ok'),
            },
    } as never;
  });
  const updates = createLazyTelegramUpdateHandler(bot);

  await updates.handleUpdate(attendanceCommandUpdate(1));
  const previewCall = apiCalls.at(-1)!;
  const addCallback = (
    previewCall.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  ).inline_keyboard
    .flat()
    .find((button) => button.text === 'Добавить участника')!.callback_data;

  await updates.handleUpdate(attendanceCallbackUpdate(2, addCallback));
  const promptCall = apiCalls.findLast(
    (call) =>
      call.method === 'sendMessage' &&
      String(call.payload.text).includes('Введите имя участника'),
  )!;
  expect(promptCall.payload.reply_markup).toMatchObject({ force_reply: true });

  await updates.handleUpdate(
    attendanceNameReplyUpdate(
      3,
      String(promptCall.payload.text),
      'Late player',
    ),
  );
  const updatedPreview = apiCalls.at(-1)!;
  expect(updatedPreview).toMatchObject({
    method: 'sendMessage',
    payload: {
      text: expect.stringMatching(
        /attendance:preview:2[\s\S]*Roster player[\s\S]*Late player/,
      ),
    },
  });
  const addedSnapshot = [...snapshots.values()].at(-1)!;
  const addedManual = addedSnapshot.entries.find(
    (entry) => entry.addedManually,
  )!;
  expect(addedManual).toEqual(
    expect.objectContaining({
      participantRef: expect.stringMatching(/^manual:/),
      displayName: 'Late player',
      billable: true,
      addedManually: true,
    }),
  );

  const billableCallback = buttonsFrom(updatedPreview).find(
    (button) => button.text === 'Взнос: да — Late player',
  )!.callback_data;
  await updates.handleUpdate(attendanceCallbackUpdate(4, billableCallback));
  const toggledPreview = apiCalls.at(-2)!;
  const toggledManual = [...snapshots.values()]
    .at(-1)!
    .entries.find((entry) => entry.addedManually)!;
  expect(toggledManual).toMatchObject({
    participantRef: addedManual.participantRef,
    billable: false,
  });

  const removeCallback = buttonsFrom(toggledPreview).find(
    (button) => button.text === 'Удалить — Late player',
  )!.callback_data;
  await updates.handleUpdate(attendanceCallbackUpdate(5, removeCallback));
  expect(
    [...snapshots.values()]
      .at(-1)!
      .entries.some((entry) => entry.addedManually),
  ).toBe(false);
});

const buttonsFrom = (call: {
  payload: Record<string, unknown>;
}): Array<{ text: string; callback_data: string }> =>
  (
    call.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  ).inline_keyboard.flat();

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');

const attendanceCommandUpdate = (updateId: number): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_788_134_400,
      chat: { id: 42, type: 'private', first_name: 'Ada' },
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      text: `/attendance ${gameId}`,
      entities: [{ type: 'bot_command', offset: 0, length: 11 }],
    },
  }) as Update;

const attendanceCallbackUpdate = (updateId: number, data: string): Update =>
  ({
    update_id: updateId,
    callback_query: {
      id: `attendance-${updateId}`,
      chat_instance: 'attendance-test',
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      data,
      message: {
        message_id: updateId,
        date: 1_788_134_400,
        chat: { id: 42, type: 'private', first_name: 'Ada' },
        text: 'attendance:preview:1',
      },
    },
  }) as Update;

const attendanceNameReplyUpdate = (
  updateId: number,
  promptText: string,
  displayName: string,
): Update =>
  ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_788_134_400,
      chat: { id: 42, type: 'private', first_name: 'Ada' },
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      text: displayName,
      reply_to_message: {
        message_id: updateId - 1,
        date: 1_788_134_400,
        chat: { id: 42, type: 'private', first_name: 'Ada' },
        from: { id: 999, is_bot: true, first_name: 'Volley' },
        text: promptText,
      },
    },
  }) as Update;
