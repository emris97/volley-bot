import type { GameId, GroupId, RegistrationId, UserId } from '@volley/domain';
import type {
  RegistrationCommandRepository,
  RegistrationResult,
} from './ports.js';

export interface WithdrawRegistrationCommand {
  groupId: GroupId;
  gameId: GameId;
  registrationId: RegistrationId;
  actorUserId: UserId;
  reason?: string;
}

export class WithdrawRegistration {
  public constructor(
    private readonly registrations: RegistrationCommandRepository,
  ) {}

  public async execute(
    command: WithdrawRegistrationCommand,
  ): Promise<RegistrationResult> {
    return this.registrations.withdraw({
      ...command,
      reason: command.reason ?? 'PARTICIPANT_WITHDREW',
    });
  }
}
