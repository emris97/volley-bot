import type {
  GroupId,
  GroupRole,
  MembershipStatus,
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
}

export class AuthorizationDeniedError extends Error {
  public constructor() {
    super('Group permission required');
    this.name = 'AuthorizationDeniedError';
  }
}

const roleRank: Readonly<Record<GroupRole, number>> = {
  MEMBER: 0,
  ORGANIZER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export class AuthorizationService {
  public constructor(private readonly repository: AuthorizationRepository) {}

  public async requireRole(
    groupId: GroupId,
    principal: AuthenticatedPrincipal,
    minimumRole: GroupRole,
  ): Promise<void> {
    const membership = await this.repository.findMembership(
      groupId,
      principal.userId,
    );
    if (
      membership?.membershipStatus !== 'ACTIVE' ||
      roleRank[membership.role] < roleRank[minimumRole]
    ) {
      throw new AuthorizationDeniedError();
    }
  }
}
