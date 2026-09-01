import type {
  Group,
  GroupId,
  GroupMembership,
  TelegramId,
} from '@volley/domain';
import type { TelegramGateway } from '../ports/telegram.gateway.js';

export interface OnboardingGroupRepository {
  upsertFromTelegram(input: {
    telegramChatId: TelegramId;
    title: string;
  }): Promise<Group>;
  upsertMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
    role: 'OWNER' | 'ADMIN',
  ): Promise<GroupMembership | void>;
  beginOnboarding(groupId: GroupId, actorTelegramId: TelegramId): Promise<void>;
}

export interface ConfigurationLinkFactory {
  create(input: {
    groupId: GroupId;
    administratorTelegramId: TelegramId;
  }): string;
}

export interface OnboardGroupCommand {
  telegramChatId: TelegramId;
  telegramUserId: TelegramId;
  title: string;
}

export class OnboardGroup {
  constructor(
    private readonly telegram: TelegramGateway,
    private readonly groups: OnboardingGroupRepository,
    private readonly links: ConfigurationLinkFactory,
  ) {}

  async execute(command: OnboardGroupCommand): Promise<{
    kind: 'ONBOARDING_STARTED';
    groupId: GroupId;
    privateChatLink: string;
  }> {
    const member = await this.telegram.getChatMember(
      command.telegramChatId,
      command.telegramUserId,
    );
    if (member.status !== 'creator' && member.status !== 'administrator') {
      throw new Error('Telegram administrator rights are required');
    }

    const group = await this.groups.upsertFromTelegram({
      telegramChatId: command.telegramChatId,
      title: command.title,
    });
    await this.groups.upsertMembership(
      group.id,
      command.telegramUserId,
      member.status === 'creator' ? 'OWNER' : 'ADMIN',
    );
    await this.groups.beginOnboarding(group.id, command.telegramUserId);

    return {
      kind: 'ONBOARDING_STARTED',
      groupId: group.id,
      privateChatLink: this.links.create({
        groupId: group.id,
        administratorTelegramId: command.telegramUserId,
      }),
    };
  }
}
