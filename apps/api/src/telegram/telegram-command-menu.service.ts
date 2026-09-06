import {
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PRIVATE_COMMANDS } from '@volley/telegram';

interface CommandMenuApi {
  setMyCommands(
    commands: typeof PRIVATE_COMMANDS,
    options: {
      scope: { type: 'all_private_chats' };
      language_code: 'ru';
    },
  ): Promise<unknown>;
  deleteMyCommands(options: {
    scope: { type: 'all_group_chats' | 'all_chat_administrators' };
    language_code: 'ru';
  }): Promise<unknown>;
}

interface CommandMenuLogger {
  warn(
    message: string,
    context: { attempt: number; errorCategory: string },
  ): void;
}

const retryDelaysMs = [1, 2, 4, 8, 16, 32, 60].map(
  (seconds) => seconds * 1_000,
);

export class TelegramCommandMenuService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly api: CommandMenuApi,
    private readonly logger: CommandMenuLogger = new Logger(
      TelegramCommandMenuService.name,
    ),
  ) {}

  public onApplicationBootstrap(): void {
    this.stopped = false;
    void this.install();
  }

  public onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async install(): Promise<void> {
    if (this.stopped) return;
    this.attempt += 1;
    try {
      await this.api.setMyCommands(PRIVATE_COMMANDS, {
        scope: { type: 'all_private_chats' },
        language_code: 'ru',
      });
      await this.api.deleteMyCommands({
        scope: { type: 'all_group_chats' },
        language_code: 'ru',
      });
      await this.api.deleteMyCommands({
        scope: { type: 'all_chat_administrators' },
        language_code: 'ru',
      });
      this.timer = undefined;
    } catch (error) {
      if (this.stopped) return;
      this.logger.warn('Telegram command menu retry', {
        attempt: this.attempt,
        errorCategory: errorCategory(error),
      });
      const delay = retryDelaysMs[this.attempt - 1] ?? 300_000;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.install();
      }, delay);
    }
  }
}

const errorCategory = (error: unknown): string => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'error_code' in error &&
    error.error_code === 429
  ) {
    return 'rate_limit';
  }
  if (
    error instanceof Error &&
    /network|timeout|fetch|socket|connect/i.test(error.message)
  ) {
    return 'network';
  }
  if (typeof error === 'object' && error !== null && 'error_code' in error) {
    return 'telegram';
  }
  return 'unknown';
};
