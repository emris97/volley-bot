import type {
  GameId,
  GroupId,
  RegistrationId,
  RegistrationState,
  UserId,
} from '@volley/domain';

export interface RegistrationResult {
  registrationId: RegistrationId;
  state: RegistrationState;
  rosterPosition?: number;
  waitlistPosition?: number;
}

export interface RegistrationMembershipResolver {
  priorityFor(groupId: GroupId, userId: UserId): Promise<number>;
}

export interface RegistrationCommandRepository {
  registerParticipant(input: {
    groupId: GroupId;
    gameId: GameId;
    userId: UserId;
    intent: 'CONFIRMED' | 'TENTATIVE';
    membershipPriority: number;
    idempotencyKey: string;
  }): Promise<RegistrationResult>;
  registerGuest(input: {
    groupId: GroupId;
    gameId: GameId;
    inviterUserId: UserId;
    guestDisplayName: string;
    idempotencyKey: string;
  }): Promise<RegistrationResult>;
  withdraw(input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    actorUserId: UserId;
    reason: string;
    allowOrganizerOverride?: boolean;
    expectedConfirmationRevision?: number;
  }): Promise<RegistrationResult>;
  changeManualRank(input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    actorUserId: UserId;
    manualRank: number | null;
    reason: string;
  }): Promise<RegistrationResult>;
}
