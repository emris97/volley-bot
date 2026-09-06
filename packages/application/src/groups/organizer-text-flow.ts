import type { GroupId, TelegramId, UserId } from '@volley/domain';

export type OrganizerTextFlowKind =
  'PAYMENT' | 'ATTENDANCE' | 'TEMPLATE' | 'GAME_CREATION' | 'GAME_EDIT';

export interface OrganizerTextFlow {
  groupId: GroupId;
  actorUserId: UserId;
  kind: OrganizerTextFlowKind;
  reference: string | null;
  updatedAt: Date;
}

export interface OrganizerTextFlowCoordinator {
  claim(input: {
    groupId: GroupId;
    actorUserId: UserId;
    kind: OrganizerTextFlowKind;
    reference?: string | null;
  }): Promise<OrganizerTextFlow>;
  current(telegramUserId: TelegramId): Promise<OrganizerTextFlow | null>;
  release(input: {
    groupId: GroupId;
    actorUserId: UserId;
    kind: OrganizerTextFlowKind;
  }): Promise<boolean>;
}
