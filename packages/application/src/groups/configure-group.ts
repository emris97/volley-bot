import type { GroupId, TelegramId } from '@volley/domain';
import type { AuthorizationService } from '../auth/authorization.service.js';

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
  configure(command: ConfigureGroupCommand): Promise<void>;
}

export class ConfigureGroup {
  constructor(
    private readonly authorization: Pick<
      AuthorizationService,
      'requireTelegramRole'
    >,
    private readonly groups: ConfigurableGroupRepository,
  ) {}

  async execute(command: ConfigureGroupCommand): Promise<void> {
    await this.authorization.requireTelegramRole(
      command.groupId,
      command.actorTelegramId,
      'ADMIN',
    );

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
