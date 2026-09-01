import type { GameId, GroupId, UserId } from '@volley/domain';
import type { GameAuthorization, GameUpdateRepository } from './ports.js';

export interface UpdateGameCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  expectedRevision: number;
  changes: { capacity?: number };
}

export class UpdateGame {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly games: GameUpdateRepository,
  ) {}

  public async execute(command: UpdateGameCommand): Promise<{
    scheduleRevision: number;
    rosterCount: number;
    waitlistCount: number;
  }> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    if (
      command.changes.capacity !== undefined &&
      (!Number.isSafeInteger(command.changes.capacity) ||
        command.changes.capacity <= 0)
    ) {
      throw new Error('Capacity must be a positive integer');
    }
    return this.games.updateGame(command);
  }
}
