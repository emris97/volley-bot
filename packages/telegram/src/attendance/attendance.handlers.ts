import type {
  AttendanceSnapshotReader,
  ConfirmAttendance,
  ConfirmAttendanceCommand,
} from '@volley/application';
import {
  asAttendanceSnapshotId,
  asGameId,
  asGroupId,
  type AttendanceSnapshot,
  type AttendanceSnapshotId,
  type GameId,
  type GroupId,
  type RegistrationId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { toTelegramId } from '../group-onboarding.handlers.js';

export interface AttendanceActorResolver {
  resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<{ groupId: GroupId; gameId: GameId; userId: UserId }>;
}

export interface AttendancePreview {
  text: string;
  snapshot: AttendanceSnapshot;
  buttons: readonly { text: string; callbackData: string }[];
  manualParticipantPrompt?: { text: string; token: string };
}

export class AttendanceHandlers {
  public constructor(
    private readonly actors: AttendanceActorResolver,
    private readonly attendance: Pick<ConfirmAttendance, 'execute'>,
    private readonly snapshots: Pick<AttendanceSnapshotReader, 'findSnapshot'>,
  ) {}

  public async preview(input: {
    telegramUserId: TelegramId;
    gameId: GameId;
    expectedRevision: number;
    excludedRegistrationIds: RegistrationId[];
    manualParticipants: Array<{ displayName: string; billable: boolean }>;
  }): Promise<AttendanceSnapshot> {
    return this.execute(input, false);
  }

  public async finalize(input: {
    telegramUserId: TelegramId;
    gameId: GameId;
    expectedRevision: number;
    excludedRegistrationIds: RegistrationId[];
    manualParticipants: Array<{ displayName: string; billable: boolean }>;
  }): Promise<AttendanceSnapshot> {
    return this.execute(input, true);
  }

  public async start(input: {
    telegramUserId: TelegramId;
    gameId: GameId;
  }): Promise<AttendancePreview> {
    return this.render(
      await this.preview({
        ...input,
        expectedRevision: 0,
        excludedRegistrationIds: [],
        manualParticipants: [],
      }),
    );
  }

  public render(snapshot: AttendanceSnapshot): AttendancePreview {
    return {
      text: snapshot.finalized
        ? `attendance:confirmed:${snapshot.revision}`
        : `attendance:preview:${snapshot.revision}`,
      snapshot,
      buttons: snapshot.finalized
        ? []
        : [
            ...snapshot.rosterCandidates.map((candidate, index) => ({
              text: `${candidate.included ? '✓' : '✗'} ${candidate.displayName}`,
              callbackData: attendanceCallback(
                'toggle',
                snapshot.groupId,
                snapshot.id,
                index,
              ),
            })),
            {
              text: 'Добавить участника',
              callbackData: attendanceCallback(
                'add',
                snapshot.groupId,
                snapshot.id,
              ),
            },
            {
              text: 'Confirm attendance',
              callbackData: attendanceCallback(
                'confirm',
                snapshot.groupId,
                snapshot.id,
              ),
            },
          ],
    };
  }

  public async handleCallback(input: {
    telegramUserId: TelegramId;
    data: string;
  }): Promise<AttendancePreview> {
    const callback = parseAttendanceCallback(input.data);
    const snapshot = await this.snapshots.findSnapshot(
      callback.groupId,
      callback.snapshotId,
    );
    if (snapshot === null) throw new Error('Attendance preview not found');
    const actor = await this.actors.resolve(
      snapshot.gameId,
      input.telegramUserId,
    );
    if (
      actor.groupId !== callback.groupId ||
      actor.gameId !== snapshot.gameId
    ) {
      throw new Error('Attendance callback identity mismatch');
    }
    if (callback.action === 'add') {
      return {
        ...this.render(snapshot),
        manualParticipantPrompt: {
          token: input.data,
          text: `${input.data}\nВведите имя участника`,
        },
      };
    }
    if (
      callback.action === 'toggle' &&
      snapshot.rosterCandidates[callback.candidateIndex] === undefined
    ) {
      throw new Error('Attendance candidate not found');
    }
    const excludedRegistrationIds = snapshot.rosterCandidates
      .filter((candidate, index) =>
        callback.action === 'toggle' && index === callback.candidateIndex
          ? candidate.included
          : !candidate.included,
      )
      .map((candidate) => candidate.sourceRegistrationId);
    const manualParticipants = snapshot.entries
      .filter((entry) => entry.addedManually)
      .map((entry) => ({
        displayName: entry.displayName,
        billable: entry.billable,
      }));
    const result = await this.attendance.execute({
      groupId: actor.groupId,
      gameId: actor.gameId,
      actorUserId: actor.userId,
      expectedRevision: snapshot.revision,
      excludedRegistrationIds,
      manualParticipants,
      finalize: callback.action === 'confirm',
    });
    return this.render(result);
  }

  public async addManualParticipant(input: {
    telegramUserId: TelegramId;
    token: string;
    displayName: string;
  }): Promise<AttendancePreview> {
    const callback = parseAttendanceCallback(input.token);
    if (callback.action !== 'add') {
      throw new Error('Invalid manual attendance prompt');
    }
    const snapshot = await this.snapshots.findSnapshot(
      callback.groupId,
      callback.snapshotId,
    );
    if (snapshot === null) throw new Error('Attendance preview not found');
    const actor = await this.actors.resolve(
      snapshot.gameId,
      input.telegramUserId,
    );
    if (
      actor.groupId !== callback.groupId ||
      actor.gameId !== snapshot.gameId
    ) {
      throw new Error('Attendance callback identity mismatch');
    }
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || [...displayName].length > 80) {
      throw new Error('Participant name must contain between 1 and 80 characters');
    }
    const result = await this.attendance.execute({
      groupId: actor.groupId,
      gameId: actor.gameId,
      actorUserId: actor.userId,
      expectedRevision: snapshot.revision,
      excludedRegistrationIds: snapshot.rosterCandidates
        .filter((candidate) => !candidate.included)
        .map((candidate) => candidate.sourceRegistrationId),
      manualParticipants: [
        ...snapshot.entries
          .filter((entry) => entry.addedManually)
          .map((entry) => ({
            displayName: entry.displayName,
            billable: entry.billable,
          })),
        { displayName, billable: true },
      ],
      finalize: false,
    });
    return this.render(result);
  }

  private async execute(
    input: Omit<
      ConfirmAttendanceCommand,
      'groupId' | 'actorUserId' | 'finalize'
    > & {
      telegramUserId: TelegramId;
    },
    finalize: boolean,
  ): Promise<AttendanceSnapshot> {
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    return this.attendance.execute({
      groupId: actor.groupId,
      gameId: actor.gameId,
      actorUserId: actor.userId,
      expectedRevision: input.expectedRevision,
      excludedRegistrationIds: input.excludedRegistrationIds,
      manualParticipants: input.manualParticipants,
      finalize,
    });
  }
}

type AttendanceCallback =
  | {
      action: 'toggle';
      groupId: GroupId;
      snapshotId: AttendanceSnapshotId;
      candidateIndex: number;
    }
  | {
      action: 'confirm';
      groupId: GroupId;
      snapshotId: AttendanceSnapshotId;
      candidateIndex?: never;
    }
  | {
      action: 'add';
      groupId: GroupId;
      snapshotId: AttendanceSnapshotId;
      candidateIndex?: never;
    };

export const attendanceCallback = (
  action: AttendanceCallback['action'],
  groupId: GroupId,
  snapshotId: AttendanceSnapshotId,
  candidateIndex?: number,
): string => {
  if (
    action === 'toggle' &&
    (candidateIndex === undefined ||
      !Number.isSafeInteger(candidateIndex) ||
      candidateIndex < 0)
  ) {
    throw new Error('Invalid attendance callback');
  }
  const callback =
    action === 'toggle'
      ? `at:t:${compactUuid(groupId)}:${compactUuid(snapshotId)}:${candidateIndex?.toString(36)}`
      : `at:${action === 'confirm' ? 'c' : 'a'}:${compactUuid(groupId)}:${compactUuid(snapshotId)}`;
  if (Buffer.byteLength(callback, 'utf8') > 64) {
    throw new Error('Telegram callback payload exceeds 64 bytes');
  }
  return callback;
};

const parseAttendanceCallback = (value: string): AttendanceCallback => {
  const [prefix, action, groupId, snapshotId, candidateIndex, ...rest] =
    value.split(':');
  if (
    prefix !== 'at' ||
    (action !== 't' && action !== 'c' && action !== 'a') ||
    groupId === undefined ||
    snapshotId === undefined ||
    rest.length > 0 ||
    (action === 't' &&
      (candidateIndex === undefined || !/^[0-9a-z]+$/i.test(candidateIndex))) ||
    (action !== 't' && candidateIndex !== undefined)
  ) {
    throw new Error('Invalid attendance callback');
  }
  const decodedGroupId = decodeCompactUuid(groupId);
  const decodedSnapshotId = decodeCompactUuid(snapshotId);
  if (action === 't') {
    return {
        action: 'toggle',
        groupId: asGroupId(decodedGroupId),
        snapshotId: asAttendanceSnapshotId(decodedSnapshotId),
        candidateIndex: Number.parseInt(candidateIndex!, 36),
      };
  }
  return {
    action: action === 'c' ? 'confirm' : 'add',
    groupId: asGroupId(decodedGroupId),
    snapshotId: asAttendanceSnapshotId(decodedSnapshotId),
  };
};

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');

const decodeCompactUuid = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error('Invalid attendance callback');
  }
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) throw new Error('Invalid attendance callback');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const registerAttendanceHandlers = (
  bot: Bot<Context>,
  handlers: AttendanceHandlers,
): Bot<Context> => {
  bot.command('attendance', async (context) => {
    if (context.from === undefined) throw new Error('Message sender is required');
    if (context.chat.type !== 'private') throw new Error('Private chat required');
    const preview = await handlers.start({
      telegramUserId: toTelegramId(context.from.id),
      gameId: parseGameId(context.match ?? ''),
    });
    await context.reply(preview.text, replyMarkup(preview));
  });
  bot.on('message:text', async (context, next) => {
    const prompt = context.message.reply_to_message?.text?.split('\n')[0];
    if (
      context.chat.type !== 'private' ||
      context.from === undefined ||
      prompt === undefined ||
      !prompt.startsWith('at:a:')
    ) {
      await next();
      return;
    }
    const preview = await handlers.addManualParticipant({
      telegramUserId: toTelegramId(context.from.id),
      token: prompt,
      displayName: context.message.text,
    });
    await context.reply(preview.text, replyMarkup(preview));
  });
  bot.callbackQuery(/^at:/, async (context) => {
    if (context.callbackQuery.message?.chat.type !== 'private') {
      throw new Error('Private chat required');
    }
    const preview = await handlers.handleCallback({
      telegramUserId: toTelegramId(context.callbackQuery.from.id),
      data: context.callbackQuery.data,
    });
    if (preview.manualParticipantPrompt === undefined) {
      await context.editMessageText(preview.text, replyMarkup(preview));
    } else {
      await context.reply(preview.manualParticipantPrompt.text, {
        reply_markup: { force_reply: true, selective: true },
      });
    }
    await context.answerCallbackQuery({ text: 'attendance:updated' });
  });
  return bot;
};

const replyMarkup = (preview: AttendancePreview) => ({
  reply_markup: {
    inline_keyboard: preview.buttons.map((button) => [
      { text: button.text, callback_data: button.callbackData },
    ]),
  },
});

const parseGameId = (value: string): GameId => {
  const trimmed = value.trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(trimmed)) {
    throw new Error('Valid game id required');
  }
  return asGameId(trimmed);
};
