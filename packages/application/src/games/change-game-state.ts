import {
  transitionGame,
  type Game,
  type GameId,
  type GameState,
  type GroupId,
  type UserId,
} from '@volley/domain';
import type { GameAuthorization, GameRepository } from './ports.js';

export interface ChangeGameStateCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  targetState: GameState;
}

export class ChangeGameState {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly games: GameRepository,
  ) {}

  public async execute(command: ChangeGameStateCommand): Promise<Game> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    return this.games.withLockedGame(
      command.groupId,
      command.gameId,
      async (game, changes) => {
        const next = transitionGame(game.state, command.targetState);
        return changes.updateState(next, command.actorUserId);
      },
    );
  }
}
