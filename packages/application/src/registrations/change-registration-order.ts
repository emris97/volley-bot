import type { GameId, GroupId, RegistrationId, UserId } from '@volley/domain';
import type { GameAuthorization } from '../games/ports.js';
import type {
  RegistrationCommandRepository,
  RegistrationResult,
} from './ports.js';

export interface ChangeRegistrationOrderCommand {
  groupId: GroupId;
  gameId: GameId;
  registrationId: RegistrationId;
  actorUserId: UserId;
  manualRank: number | null;
  reason: string;
}

export class ChangeRegistrationOrder {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly registrations: RegistrationCommandRepository,
  ) {}

  public async execute(
    command: ChangeRegistrationOrderCommand,
  ): Promise<RegistrationResult> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    if (
      command.manualRank !== null &&
      (!Number.isSafeInteger(command.manualRank) || command.manualRank < 0)
    ) {
      throw new Error('Manual rank must be a non-negative integer');
    }
    return this.registrations.changeManualRank(command);
  }
}
