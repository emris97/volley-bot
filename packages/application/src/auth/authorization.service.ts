import type {
  GroupId,
  GroupRole,
  GroupMembership,
  MembershipStatus,
  TelegramId,
  UserId,
} from '@volley/domain';
import type { AuthenticatedPrincipal } from './authenticated-principal.js';

export interface AuthorizationRepository {
  findMembership(
    groupId: GroupId,
    userId: UserId,
  ): Promise<{
    role: GroupRole;
    membershipStatus: MembershipStatus;
  } | null>;
  findMembershipByTelegramUserId(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<GroupMembership | null>;
}

export class AuthorizationDeniedError extends Error {
  public constructor() {
    super('Group permission required');
    this.name = 'AuthorizationDeniedError';
  }
}

export interface OrganizerAuthorization {
  requireOrganizer(groupId: GroupId, actorUserId: UserId): Promise<void>;
}

const roleRank: Readonly<Record<GroupRole, number>> = {
  MEMBER: 0,
  ORGANIZER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export class AuthorizationService implements OrganizerAuthorization {
  public constructor(private readonly repository: AuthorizationRepository) {}

  public async requireRole(
    groupId: GroupId,
    actor: AuthenticatedPrincipal | UserId,
    minimumRole: GroupRole,
  ): Promise<void> {
    const userId = typeof actor === 'string' ? actor : actor.userId;
    const membership = await this.repository.findMembership(groupId, userId);
    this.assertRole(membership, minimumRole);
  }

  public async requireTelegramRole(
    groupId: GroupId,
    telegramUserId: TelegramId,
    minimumRole: GroupRole,
  ): Promise<UserId> {
    const membership = await this.repository.findMembershipByTelegramUserId(
      groupId,
      telegramUserId,
    );
    this.assertRole(membership, minimumRole);
    return membership!.userId;
  }

  public requireOrganizer(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<void> {
    return this.requireRole(groupId, actorUserId, 'ORGANIZER');
  }

  private assertRole(
    membership: {
      role: GroupRole;
      membershipStatus: MembershipStatus;
    } | null,
    minimumRole: GroupRole,
  ): void {
    if (
      membership?.membershipStatus !== 'ACTIVE' ||
      roleRank[membership.role] < roleRank[minimumRole]
    ) {
      throw new AuthorizationDeniedError();
    }
  }
}
