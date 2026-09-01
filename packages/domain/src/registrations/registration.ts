import type { GameId } from '../games/game.js';
import type { GroupId, UserId } from '../identity.js';

declare const registrationIdBrand: unique symbol;

export type RegistrationId = string & {
  readonly [registrationIdBrand]: 'RegistrationId';
};

export type RegistrationState =
  | 'TENTATIVE'
  | 'ROSTERED'
  | 'WAITLISTED'
  | 'CANCELLED';

export type RegistrationKind = 'MEMBER' | 'GUEST';

export interface RegistrationCandidate {
  id: RegistrationId;
  kind: RegistrationKind;
  state: RegistrationState;
  manualRank: number | null;
  membershipPriority: number;
  confirmedAt: Date | null;
}

export interface Registration extends RegistrationCandidate {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId | null;
  guestDisplayName: string | null;
  inviterUserId: UserId | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
}

export const asRegistrationId = (value: string): RegistrationId =>
  value as RegistrationId;
