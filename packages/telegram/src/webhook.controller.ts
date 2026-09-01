import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { MetricsRegistry } from '@volley/application';
import type { Update } from 'grammy/types';

export interface TelegramUpdateHandler {
  handleUpdate(update: Update): Promise<void>;
}

export const TELEGRAM_UPDATE_HANDLER = Symbol('TELEGRAM_UPDATE_HANDLER');
export const TELEGRAM_WEBHOOK_SECRET = Symbol('TELEGRAM_WEBHOOK_SECRET');

@Controller('telegram/webhook')
export class WebhookController {
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
      return { ok: true };
    } catch (error) {
      this.metrics?.recordWebhook(
        'failure',
        (performance.now() - startedAt) / 1_000,
      );
      throw error;
    }
  }
}
