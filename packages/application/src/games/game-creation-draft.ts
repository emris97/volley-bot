import type {
  GameId,
  GameTemplateId,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';

export type GameCreationDraftStep =
  'TEMPLATE' | 'DATE' | 'CUSTOMIZE' | 'PREVIEW' | 'PUBLISHED';

export interface GameCreationDraft {
  version: 1;
  draftId: string;
  groupId: GroupId;
  actorUserId: UserId;
  step: GameCreationDraftStep;
  templateId?: GameTemplateId;
  snapshot?: GameTemplateSnapshot;
  startsAtIso?: string;
  previewed: boolean;
  publishedGameId?: GameId;
}
