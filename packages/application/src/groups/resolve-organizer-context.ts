import type {
  GroupId,
  GroupRole,
  MembershipStatus,
  OnboardingState,
  TelegramId,
  UserId,
} from '@volley/domain';
import type {
  TelegramGateway,
  TelegramMemberStatus,
} from '../ports/telegram.gateway.js';

export interface OrganizerGroupCandidate {
  groupId: GroupId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
  selected: boolean;
}

export interface OrganizerContext {
  groupId: GroupId;
  userId: UserId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
}

export interface StoredOrganizerGroup {
  groupId: GroupId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
  enabled: boolean;
  onboardingState: OnboardingState;
  userId: UserId;
  role: GroupRole;
  status: MembershipStatus;
}

export interface OrganizerDirectory {
  listKnownGroups(
    telegramUserId: TelegramId,
  ): Promise<readonly StoredOrganizerGroup[]>;
  findKnownGroup(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<StoredOrganizerGroup | null>;
  refreshMembership(input: {
    groupId: GroupId;
    telegramUserId: TelegramId;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    status: 'ACTIVE' | 'LEFT';
  }): Promise<UserId>;
  selectedGroup(telegramUserId: TelegramId): Promise<GroupId | null>;
  saveSelectedGroup(
    telegramUserId: TelegramId,
    groupId: GroupId,
  ): Promise<void>;
}

export class OrganizerGroupSelectionRequiredError extends Error {
  public constructor() {
    super('Select an organizer group');
    this.name = 'OrganizerGroupSelectionRequiredError';
  }
}

const administrativeRole = (
  status: TelegramMemberStatus,
): 'OWNER' | 'ADMIN' | null =>
  status === 'creator' ? 'OWNER' : status === 'administrator' ? 'ADMIN' : null;

const isAvailable = (
  group: StoredOrganizerGroup,
  role: 'OWNER' | 'ADMIN' | null,
): role is 'OWNER' | 'ADMIN' =>
  role !== null && group.enabled && group.onboardingState === 'CONFIGURED';

export class ResolveOrganizerContext {
  public constructor(
    private readonly telegram: Pick<TelegramGateway, 'getChatMember'>,
    private readonly directory: OrganizerDirectory,
  ) {}

  public async list(
    telegramUserId: TelegramId,
  ): Promise<readonly OrganizerGroupCandidate[]> {
    return (await this.resolve(telegramUserId)).map(
      ({ candidate }) => candidate,
    );
  }

  public async require(
    telegramUserId: TelegramId,
    requestedGroupId?: GroupId,
  ): Promise<OrganizerContext> {
    const groups = await this.resolve(telegramUserId);
    const requested =
      requestedGroupId === undefined
        ? (groups.find((group) => group.candidate.selected) ??
          (groups.length === 1 ? groups[0] : undefined))
        : groups.find((group) => group.candidate.groupId === requestedGroupId);

    if (requested === undefined) {
      throw new OrganizerGroupSelectionRequiredError();
    }

    return this.toContext(requested.group);
  }

  public async select(
    telegramUserId: TelegramId,
    groupId: GroupId,
  ): Promise<OrganizerContext> {
    const group = await this.directory.findKnownGroup(groupId, telegramUserId);
    if (group === null) {
      throw new OrganizerGroupSelectionRequiredError();
    }

    const member = await this.telegram.getChatMember(
      group.telegramChatId,
      telegramUserId,
    );
    const role = administrativeRole(member.status);
    await this.directory.refreshMembership({
      groupId,
      telegramUserId,
      role: role ?? 'MEMBER',
      status: role === null ? 'LEFT' : 'ACTIVE',
    });
    if (!isAvailable(group, role)) {
      throw new OrganizerGroupSelectionRequiredError();
    }

    await this.directory.saveSelectedGroup(telegramUserId, groupId);
    return this.toContext(group);
  }

  private async resolve(telegramUserId: TelegramId): Promise<
    readonly {
      group: StoredOrganizerGroup;
      candidate: OrganizerGroupCandidate;
    }[]
  > {
    const [groups, selectedGroupId] = await Promise.all([
      this.directory.listKnownGroups(telegramUserId),
      this.directory.selectedGroup(telegramUserId),
    ]);
    const resolved = await Promise.all(
      groups.map(async (group) => {
        const member = await this.telegram.getChatMember(
          group.telegramChatId,
          telegramUserId,
        );
        const role = administrativeRole(member.status);
        await this.directory.refreshMembership({
          groupId: group.groupId,
          telegramUserId,
          role: role ?? 'MEMBER',
          status: role === null ? 'LEFT' : 'ACTIVE',
        });
        if (!isAvailable(group, role)) return null;

        return {
          group,
          candidate: {
            groupId: group.groupId,
            telegramChatId: group.telegramChatId,
            title: group.title,
            timeZone: group.timeZone,
            selected: group.groupId === selectedGroupId,
          },
        };
      }),
    );

    return resolved.filter(
      (group): group is NonNullable<typeof group> => group !== null,
    );
  }

  private toContext(group: StoredOrganizerGroup): OrganizerContext {
    return {
      groupId: group.groupId,
      userId: group.userId,
      telegramChatId: group.telegramChatId,
      title: group.title,
      timeZone: group.timeZone,
    };
  }
}
