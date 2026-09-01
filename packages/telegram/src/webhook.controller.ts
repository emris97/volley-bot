import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Optional,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  currentLogContext,
  MetricsRegistry,
  runWithLogContext,
} from '@volley/application';
import type { Update } from 'grammy/types';

export interface TelegramUpdateHandler {
  handleUpdate(update: Update): Promise<void>;
}

export const TELEGRAM_UPDATE_HANDLER = Symbol('TELEGRAM_UPDATE_HANDLER');
export const TELEGRAM_WEBHOOK_SECRET = Symbol('TELEGRAM_WEBHOOK_SECRET');

@Controller('telegram/webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @Inject(TELEGRAM_UPDATE_HANDLER)
    private readonly bot: TelegramUpdateHandler,
    @Inject(TELEGRAM_WEBHOOK_SECRET)
    private readonly secret: string,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Headers('x-telegram-bot-api-secret-token')
    providedSecret: string | undefined,
    @Body() update: Update,
  ): Promise<{ ok: true }> {
    return runWithLogContext(telegramLogContext(update), async () => {
      const startedAt = performance.now();
      if (providedSecret !== this.secret) {
        this.metrics?.recordWebhook(
          'unauthorized',
          (performance.now() - startedAt) / 1_000,
        );
        throw new UnauthorizedException();
      }
      try {
        await this.bot.handleUpdate(update);
        this.metrics?.recordWebhook(
          'success',
          (performance.now() - startedAt) / 1_000,
        );
        this.logger.log('Telegram update handled');
        return { ok: true };
      } catch (error) {
        this.metrics?.recordWebhook(
          'failure',
          (performance.now() - startedAt) / 1_000,
        );
        throw error;
      }
    });
  }
}

const telegramLogContext = (update: Update) => ({
  correlationId:
    currentLogContext().correlationId ?? `telegram:${update.update_id}`,
  updateId: String(update.update_id),
  ...(telegramChatId(update) === undefined
    ? {}
    : { groupId: telegramChatId(update) }),
});

const telegramChatId = (update: Update): string | undefined => {
  const candidate = update as unknown as Record<string, unknown>;
  for (const key of [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'my_chat_member',
    'chat_member',
    'chat_join_request',
  ]) {
    const envelope = asRecord(candidate[key]);
    const chat = asRecord(envelope?.chat);
    if (typeof chat?.id === 'number') return String(chat.id);
  }
  const callback = asRecord(candidate.callback_query);
  const callbackMessage = asRecord(callback?.message);
  const callbackChat = asRecord(callbackMessage?.chat);
  return typeof callbackChat?.id === 'number'
    ? String(callbackChat.id)
    : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
