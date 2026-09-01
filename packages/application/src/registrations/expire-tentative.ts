import type { GameId, GroupId, RegistrationId } from '@volley/domain';
import type { TentativeRegistrationRepository } from './confirm-tentative.js';

export class ExpireTentative {
  public constructor(
    private readonly registrations: Pick<
      TentativeRegistrationRepository,
      'expireTentative'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public execute(command: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    expectedConfirmationRevision: number;
  }): Promise<{ expired: boolean }> {
    return this.registrations.expireTentative({
      ...command,
      expiredAt: this.now(),
    });
  }
}
