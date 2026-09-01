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

  public render(snapshot: AttendanceSnapshot): AttendancePreview {
    return {
      text: snapshot.finalized
        ? `attendance:confirmed:${snapshot.revision}`
        : `attendance:preview:${snapshot.revision}`,
      snapshot,
      buttons: [
        ...snapshot.entries.map((entry) => ({
          text: `${entry.addedManually ? '+' : '✓'} ${entry.displayName}`,
          callbackData: `at:toggle:${snapshot.revision}:${entry.participantRef}`,
        })),
        ...(snapshot.finalized
          ? []
          : [
              {
                text: 'Confirm attendance',
                callbackData: `at:confirm:${snapshot.revision}`,
              },
            ]),
      ],
    };
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
