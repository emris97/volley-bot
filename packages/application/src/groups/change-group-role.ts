import type {
  Group,
  GroupId,
  GroupMembership,
  GroupRole,
  TelegramId,
} from '@volley/domain';
import type { AuthorizationService } from '../auth/authorization.service.js';
import type { TelegramGateway } from '../ports/telegram.gateway.js';

export interface RoleGroupRepository {
  findById(groupId: GroupId): Promise<Group | null>;
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
    private readonly authorization: Pick<
      AuthorizationService,
      'requireTelegramRole'
    >,
    private readonly groups: RoleGroupRepository,
  ) {}

  async execute(command: ChangeGroupRoleCommand): Promise<void> {
    await this.authorization.requireTelegramRole(
      command.groupId,
      command.actorTelegramId,
      'ADMIN',
    );

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
