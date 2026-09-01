import type { GroupId, TelegramId } from '@volley/domain';

export interface ConfigureGroupCommand {
  groupId: GroupId;
  actorTelegramId: TelegramId;
  timeZone: string;
  memberPriorityEnabled: boolean;
  tentativePromptMinutesBefore: number;
  tentativeResponseMinutes: number;
  reminderMinutesBefore: number;
  currency: 'RUB';
  roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
  pinGameMessages: boolean;
}

export interface ConfigurableGroupRepository {
  findMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<{ role: string; membershipStatus: string } | null>;
  configure(command: ConfigureGroupCommand): Promise<void>;
}

export class ConfigureGroup {
  constructor(private readonly groups: ConfigurableGroupRepository) {}

  async execute(command: ConfigureGroupCommand): Promise<void> {
    const actor = await this.groups.findMembership(
      command.groupId,
      command.actorTelegramId,
    );
    if (
      actor?.membershipStatus !== 'ACTIVE' ||
      (actor.role !== 'OWNER' && actor.role !== 'ADMIN')
    ) {
      throw new Error('Only an owner or admin may configure a group');
    }

    try {
      new Intl.DateTimeFormat('en', { timeZone: command.timeZone }).format();
    } catch {
      throw new Error('Invalid IANA time zone');
    }

    for (const value of [
      command.tentativePromptMinutesBefore,
      command.tentativeResponseMinutes,
      command.reminderMinutesBefore,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Reminder timings must be non-negative integers');
      }
    }

    await this.groups.configure(command);
  }
}
