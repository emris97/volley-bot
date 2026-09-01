import type { Game, GameId, GroupId } from '@volley/domain';

export interface GameQueryRepository {
  findById(groupId: GroupId, gameId: GameId): Promise<Game | null>;
}

export class GetGame {
  public constructor(private readonly games: GameQueryRepository) {}

  public getGame(groupId: GroupId, gameId: GameId): Promise<Game | null> {
    return this.games.findById(groupId, gameId);
  }
}
