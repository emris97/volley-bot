import type {
  GameId,
  GameTemplateId,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';

export type GameCreationDraftStep =
  'TEMPLATE' | 'DATE' | 'CUSTOMIZE' | 'PREVIEW' | 'PUBLISHED';

export type GameCreationDraftEditField =
  | 'NAME'
  | 'VENUE'
  | 'ADDRESS'
  | 'TIME'
  | 'DURATION'
  | 'CAPACITY'
  | 'OPENING'
  | 'CLOSING'
  | 'CONFIRMATION_PROMPT'
  | 'CONFIRMATION_RESPONSE'
  | 'REMINDER'
  | 'MEMBER_PRIORITY'
  | 'COST'
  | 'ROUNDING';

export interface GameCreationDraft {
  version: 1;
  draftId: string;
  groupId: GroupId;
  actorUserId: UserId;
  step: GameCreationDraftStep;
  /** Absent only on drafts written before the private wizard was connected. */
  viewRevision?: number;
  editingField?: GameCreationDraftEditField;
  cancelPending?: boolean;
  templateId?: GameTemplateId;
  snapshot?: GameTemplateSnapshot;
  startsAtIso?: string;
  previewed: boolean;
  publishedGameId?: GameId;
}

export interface GameCreationDraftExpectedView {
  draftId: string;
  step: GameCreationDraftStep;
  viewRevision: number;
}

export type GameCreationDraftMutationResult = 'SAVED' | 'STALE';
