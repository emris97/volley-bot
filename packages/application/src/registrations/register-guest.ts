import type { GameId, GroupId, UserId } from '@volley/domain';
import type {
  RegistrationCommandRepository,
  RegistrationResult,
} from './ports.js';

export interface RegisterGuestCommand {
  groupId: GroupId;
  gameId: GameId;
  inviterUserId: UserId;
  guestDisplayName: string;
  idempotencyKey: string;
}

export class RegisterGuest {
  public constructor(
    private readonly registrations: RegistrationCommandRepository,
  ) {}

  public async execute(
    command: RegisterGuestCommand,
  ): Promise<RegistrationResult> {
    const guestDisplayName = command.guestDisplayName.trim();
    if (guestDisplayName.length === 0 || [...guestDisplayName].length > 80) {
      throw new Error('Guest name must contain between 1 and 80 characters');
    }
    return this.registrations.registerGuest({ ...command, guestDisplayName });
  }
}
