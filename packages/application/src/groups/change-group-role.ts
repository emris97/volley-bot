import type {
  Group,
  GroupId,
  GroupMembership,
  GroupRole,
  TelegramId,
} from '@volley/domain';
import type { TelegramGateway } from '../ports/telegram.gateway.js';

export interface RoleGroupRepository {
  findById(groupId: GroupId): Promise<Group | null>;
  findMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<Pick<GroupMembership, 'role' | 'membershipStatus'> | null>;
  upsertMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
    role: GroupRole,
  ): Promise<GroupMembership | void>;
  recordRoleChange(input: {
    groupId: GroupId;
    actorTelegramId: TelegramId;
    targetTelegramId: TelegramId;
    role: 'ORGANIZER' | 'MEMBER';
  }): Promise<void>;
}

export interface ChangeGroupRoleCommand {
  groupId: GroupId;
  actorTelegramId: TelegramId;
  targetTelegramId: TelegramId;
  role: 'ORGANIZER' | 'MEMBER';
}

export class ChangeGroupRole {
  constructor(
    private readonly telegram: TelegramGateway,
    private readonly groups: RoleGroupRepository,
  ) {}

  async execute(command: ChangeGroupRoleCommand): Promise<void> {
    const actor = await this.groups.findMembership(
      command.groupId,
      command.actorTelegramId,
    );
    if (
      actor?.membershipStatus !== 'ACTIVE' ||
      (actor.role !== 'OWNER' && actor.role !== 'ADMIN')
    ) {
      throw new Error('Only an owner or admin may change group roles');
    }

    const group = await this.groups.findById(command.groupId);
    if (group === null) {
      throw new Error('Group not found');
    }

    const target = await this.telegram.getChatMember(
      group.telegramChatId,
      command.targetTelegramId,
    );
    if (target.status === 'left' || target.status === 'kicked') {
      throw new Error('Target user is not a current Telegram group member');
    }

    await this.groups.upsertMembership(
      command.groupId,
      command.targetTelegramId,
      command.role,
    );
    await this.groups.recordRoleChange(command);
  }
}
