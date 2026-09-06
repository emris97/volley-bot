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
import type { OrganizerAuthorization } from '../auth/authorization.service.js';
import type { GameCreationDraft } from './game-creation-draft.js';
import type {
  GameUpdateChanges,
  MaterialGameField,
} from './game-edit-policy.js';

export type GameAuthorization = OrganizerAuthorization;

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
  list(
    groupId: GroupId,
    options: {
      archived: boolean;
      limit: number;
      afterId?: GameTemplateId | null;
    },
  ): Promise<TemplatePage>;
  update(input: {
    groupId: GroupId;
    templateId: GameTemplateId;
    expectedRevision: number;
    snapshot: GameTemplateSnapshot;
  }): Promise<GameTemplate | null>;
  setArchived(input: {
    groupId: GroupId;
    templateId: GameTemplateId;
    expectedRevision: number;
    archived: boolean;
  }): Promise<GameTemplate | null>;
}

export interface TemplatePage {
  items: readonly GameTemplate[];
  nextCursor: GameTemplateId | null;
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

export interface GamePublicationRepository {
  publishDraft(
    input: {
      groupId: GroupId;
      actorUserId: UserId;
      draftId: string;
      expectedStep: GameCreationDraft['step'];
      expectedViewRevision: number;
      now: Date;
    },
    build: (draft: GameCreationDraft) => Game,
  ): Promise<{ game: Game; created: boolean }>;
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
    changes: GameUpdateChanges;
  }): Promise<{
    game: Game;
    rosterCount: number;
    waitlistCount: number;
    materialFields: readonly MaterialGameField[];
  }>;
}

export type DeleteDraftResult =
  'DELETED' | 'NOT_FOUND' | 'STALE' | 'NOT_DELETABLE';

export interface DraftGameRepository {
  deleteDraft(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
    expectedRevision: number;
  }): Promise<DeleteDraftResult>;
}
