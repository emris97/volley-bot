import type {
  ConfirmAttendance,
  ConfirmAttendanceCommand,
} from '@volley/application';
import type {
  AttendanceSnapshot,
  GameId,
  GroupId,
  RegistrationId,
  TelegramId,
  UserId,
} from '@volley/domain';
import { randomUUID } from 'node:crypto';
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
}

export class AttendanceHandlers {
  private readonly sessions = new Map<string, AttendanceSession>();

  public constructor(
    private readonly actors: AttendanceActorResolver,
    private readonly attendance: Pick<ConfirmAttendance, 'execute'>,
  ) {}

  public async preview(input: {
    telegramUserId: TelegramId;
    gameId: GameId;
    expectedRevision: number;
    excludedRegistrationIds: RegistrationId[];
    manualParticipants: Array<{ displayName: string; billable: boolean }>;
  }): Promise<AttendanceSnapshot> {
    const snapshot = await this.execute(input, false);
    this.remember(input.telegramUserId, snapshot);
    return snapshot;
  }

  public async finalize(input: {
    telegramUserId: TelegramId;
    gameId: GameId;
    expectedRevision: number;
    excludedRegistrationIds: RegistrationId[];
    manualParticipants: Array<{ displayName: string; billable: boolean }>;
  }): Promise<AttendanceSnapshot> {
    const snapshot = await this.execute(input, true);
    this.remember(input.telegramUserId, snapshot);
    return snapshot;
  }

  public render(snapshot: AttendanceSnapshot): AttendancePreview {
    return {
      text: snapshot.finalized
        ? `attendance:confirmed:${snapshot.revision}`
        : `attendance:preview:${snapshot.revision}`,
      snapshot,
      buttons: snapshot.finalized ? [] : this.buttonsFor(snapshot),
    };
  }

  public async handleCallback(input: {
    telegramUserId: TelegramId;
    data: string;
  }): Promise<AttendancePreview> {
    const callback = parseAttendanceCallback(input.data);
    const session = this.sessions.get(callback.token);
    if (
      session === undefined ||
      session.telegramUserId !== input.telegramUserId
    ) {
      throw new Error('Attendance preview has expired');
    }
    if (session.snapshot.revision !== callback.revision) {
      return this.render(session.snapshot);
    }
    const excludedRegistrationIds = session.snapshot.rosterCandidates
      .filter((candidate) =>
        callback.action === 'toggle' &&
        candidate.sourceRegistrationId === callback.registrationId
          ? candidate.included
          : !candidate.included,
      )
      .map((candidate) => candidate.sourceRegistrationId);
    const manualParticipants = session.snapshot.entries
      .filter((entry) => entry.addedManually)
      .map((entry) => ({
        displayName: entry.displayName,
        billable: entry.billable,
      }));
    const snapshot = await this.execute(
      {
        telegramUserId: input.telegramUserId,
        gameId: session.snapshot.gameId,
        expectedRevision: session.snapshot.revision,
        excludedRegistrationIds,
        manualParticipants,
      },
      callback.action === 'confirm',
    );
    this.remember(input.telegramUserId, snapshot, callback.token);
    return this.render(snapshot);
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

  private buttonsFor(
    snapshot: AttendanceSnapshot,
  ): AttendancePreview['buttons'] {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.snapshot === snapshot,
    );
    if (session === undefined)
      throw new Error('Attendance preview has expired');
    return [
      ...snapshot.rosterCandidates.map((candidate) => ({
        text: `${candidate.included ? '✓' : '✗'} ${candidate.displayName}`,
        callbackData: `at:t:${session.token}:${snapshot.revision}:${candidate.sourceRegistrationId}`,
      })),
      {
        text: 'Confirm attendance',
        callbackData: `at:c:${session.token}:${snapshot.revision}`,
      },
    ];
  }

  private remember(
    telegramUserId: TelegramId,
    snapshot: AttendanceSnapshot,
    token = createSessionToken(),
  ): void {
    this.sessions.set(token, { token, telegramUserId, snapshot });
  }
}

interface AttendanceSession {
  token: string;
  telegramUserId: TelegramId;
  snapshot: AttendanceSnapshot;
}

type AttendanceCallback =
  | {
      action: 'toggle';
      token: string;
      revision: number;
      registrationId: RegistrationId;
    }
  | {
      action: 'confirm';
      token: string;
      revision: number;
      registrationId?: never;
    };

const createSessionToken = (): string =>
  randomUUID().replaceAll('-', '').slice(0, 12);

const parseAttendanceCallback = (value: string): AttendanceCallback => {
  const [prefix, action, token, revision, registrationId, ...rest] =
    value.split(':');
  if (
    prefix !== 'at' ||
    (action !== 't' && action !== 'c') ||
    token === undefined ||
    !/^[a-f0-9]{12}$/i.test(token) ||
    revision === undefined ||
    !/^\d+$/.test(revision) ||
    rest.length > 0 ||
    (action === 't' && registrationId === undefined) ||
    (action === 'c' && registrationId !== undefined)
  ) {
    throw new Error('Invalid attendance callback');
  }
  return action === 't'
    ? {
        action: 'toggle',
        token,
        revision: Number(revision),
        registrationId: registrationId as RegistrationId,
      }
    : { action: 'confirm', token, revision: Number(revision) };
};

export const registerAttendanceHandlers = (
  bot: Bot<Context>,
  handlers: AttendanceHandlers,
): Bot<Context> => {
  bot.callbackQuery(/^at:/, async (context) => {
    const preview = await handlers.handleCallback({
      telegramUserId: toTelegramId(context.callbackQuery.from.id),
      data: context.callbackQuery.data,
    });
    await context.editMessageText(preview.text, {
      reply_markup: {
        inline_keyboard: preview.buttons.map((button) => [
          { text: button.text, callback_data: button.callbackData },
        ]),
      },
    });
    await context.answerCallbackQuery({ text: 'attendance:updated' });
  });
  return bot;
};
