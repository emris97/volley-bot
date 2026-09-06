import type { Game, GameId, GroupId, UserId } from '@volley/domain';
import {
  normalizeGameChanges,
  type GameUpdateChanges,
  type MaterialGameField,
} from './game-edit-policy.js';
import type { GameAuthorization, GameUpdateRepository } from './ports.js';

export interface UpdateGameCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  expectedRevision: number;
  changes: GameUpdateChanges;
}

export class UpdateGame {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly games: GameUpdateRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(command: UpdateGameCommand): Promise<{
    game: Game;
    rosterCount: number;
    waitlistCount: number;
    materialFields: readonly MaterialGameField[];
  }> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const changes = normalizeGameChanges(command.changes, this.now());
    return this.games.updateGame({ ...command, changes });
  }
}
