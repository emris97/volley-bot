import type {
  GameId,
  GroupId,
  RegistrationId,
  RegistrationState,
  UserId,
} from '@volley/domain';

export interface TentativeRegistrationResult {
  registrationId: RegistrationId;
  state: RegistrationState;
  confirmedAt: Date | null;
  confirmationRevision: number;
}

export interface TentativeRegistrationRepository {
  confirmTentative(input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    actorUserId: UserId;
    confirmedAt: Date;
  }): Promise<TentativeRegistrationResult>;
  expireTentative(input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    expectedConfirmationRevision: number;
    expiredAt: Date;
  }): Promise<{ expired: boolean }>;
}

export class ConfirmTentative {
  public constructor(
    private readonly registrations: Pick<
      TentativeRegistrationRepository,
      'confirmTentative'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public execute(command: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    actorUserId: UserId;
  }): Promise<TentativeRegistrationResult> {
    return this.registrations.confirmTentative({
      ...command,
      confirmedAt: this.now(),
    });
  }
}
