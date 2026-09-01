import type { GameId, GroupId, UserId } from '@volley/domain';
import type {
  RegistrationCommandRepository,
  RegistrationMembershipResolver,
  RegistrationResult,
} from './ports.js';

export interface RegisterParticipantCommand {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  intent: 'CONFIRMED' | 'TENTATIVE';
  idempotencyKey: string;
}

export class RegisterParticipant {
  public constructor(
    private readonly membership: RegistrationMembershipResolver,
    private readonly registrations: RegistrationCommandRepository,
  ) {}

  public async execute(
    command: RegisterParticipantCommand,
  ): Promise<RegistrationResult> {
    const membershipPriority = await this.membership.priorityFor(
      command.groupId,
      command.userId,
    );
    return this.registrations.registerParticipant({
      ...command,
      membershipPriority,
    });
  }
}
