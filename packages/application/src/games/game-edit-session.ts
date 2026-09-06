import type { GameId, GroupId, UserId } from '@volley/domain';
import type {
  GameEditableField,
  GameUpdateChanges,
} from './game-edit-policy.js';

export interface GameEditSession {
  groupId: GroupId;
  actorUserId: UserId;
  gameId: GameId;
  expectedGameRevision: number;
  selectedField: GameEditableField;
  interactionRevision: number;
  pendingChanges: GameUpdateChanges | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StartGameEditSessionInput {
  groupId: GroupId;
  actorUserId: UserId;
  gameId: GameId;
  expectedGameRevision: number;
  selectedField: GameEditableField;
}

export interface SaveGameEditSessionChangesInput {
  groupId: GroupId;
  actorUserId: UserId;
  gameId: GameId;
  expectedGameRevision: number;
  expectedInteractionRevision: number;
  pendingChanges: GameUpdateChanges;
}

export interface ClearGameEditSessionInput {
  groupId: GroupId;
  actorUserId: UserId;
  gameId: GameId;
  expectedInteractionRevision: number;
}
