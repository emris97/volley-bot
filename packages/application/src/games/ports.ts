import type {
  Game,
  GameId,
  GameState,
  GameTemplate,
  GameTemplateId,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';

export interface GameAuthorization {
  requireOrganizer(groupId: GroupId, actorUserId: UserId): Promise<void>;
}

export interface GameGroupSettingsRepository {
  findTimeZone(groupId: GroupId): Promise<string | null>;
}

export interface TemplateRepository {
  findById(
    groupId: GroupId,
    templateId: GameTemplateId,
  ): Promise<GameTemplate | null>;
  insert(
    template: GameTemplateSnapshot & { groupId: GroupId },
  ): Promise<GameTemplate>;
}

export interface LockedGameChanges {
  updateState(state: GameState, actorUserId?: UserId): Promise<Game>;
}

export interface GameRepository {
  insert(game: Game, actorUserId?: UserId): Promise<Game>;
  withLockedGame<T>(
    groupId: GroupId,
    gameId: GameId,
    callback: (game: Game, changes: LockedGameChanges) => Promise<T>,
  ): Promise<T>;
}

export interface UnitOfWork {
  transaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface GameUpdateRepository {
  updateGame(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
    expectedRevision: number;
    changes: { capacity?: number };
  }): Promise<{
    scheduleRevision: number;
    rosterCount: number;
    waitlistCount: number;
  }>;
}
