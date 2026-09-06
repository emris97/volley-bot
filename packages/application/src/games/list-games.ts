import type { Game, GameId, GroupId, UserId } from '@volley/domain';
import type { GameAuthorization } from './ports.js';

export type GameListBucket = 'UPCOMING' | 'HISTORY' | 'CANCELLED';

export interface GamePage {
  items: readonly Game[];
  nextCursor: GameId | null;
}

export interface GameListRepository {
  list(
    groupId: GroupId,
    options: {
      bucket: GameListBucket;
      limit: 8;
      cursor?: GameId | null;
    },
  ): Promise<GamePage>;
}

export interface ListGamesCommand {
  groupId: GroupId;
  actorUserId: UserId;
  bucket: GameListBucket;
  limit: 8;
  cursor?: GameId | null;
}

export class ListGames {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly games: GameListRepository,
  ) {}

  public async execute(command: ListGamesCommand): Promise<GamePage> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    return this.games.list(command.groupId, {
      bucket: command.bucket,
      limit: command.limit,
      cursor: command.cursor,
    });
  }
}
