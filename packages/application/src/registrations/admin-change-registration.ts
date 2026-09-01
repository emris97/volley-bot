import type { GameId, GroupId, RegistrationId, UserId } from '@volley/domain';
import type { GameAuthorization } from '../games/ports.js';
import type {
  RegistrationCommandRepository,
  RegistrationResult,
} from './ports.js';

interface AdminRegistrationBase {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  reason: string;
}

export type AdminChangeRegistrationCommand = AdminRegistrationBase &
  (
    | {
        action: 'CANCEL';
        registrationId: RegistrationId;
      }
    | {
        action: 'ADD_NAMED';
        guestDisplayName: string;
        idempotencyKey: string;
      }
  );

export class AdminChangeRegistration {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly registrations: RegistrationCommandRepository,
  ) {}

  public async execute(
    command: AdminChangeRegistrationCommand,
  ): Promise<RegistrationResult> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    if (command.action === 'ADD_NAMED') {
      const guestDisplayName = command.guestDisplayName.trim();
      if (guestDisplayName.length === 0 || [...guestDisplayName].length > 80) {
        throw new Error('Guest name must contain between 1 and 80 characters');
      }
      return this.registrations.registerGuest({
        groupId: command.groupId,
        gameId: command.gameId,
        inviterUserId: command.actorUserId,
        guestDisplayName,
        idempotencyKey: command.idempotencyKey,
      });
    }
    return this.registrations.withdraw({
      groupId: command.groupId,
      gameId: command.gameId,
      registrationId: command.registrationId,
      actorUserId: command.actorUserId,
      reason: command.reason,
      allowOrganizerOverride: true,
    });
  }
}
