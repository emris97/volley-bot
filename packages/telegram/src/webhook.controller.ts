import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
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
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Headers('x-telegram-bot-api-secret-token')
    providedSecret: string | undefined,
    @Body() update: Update,
  ): Promise<{ ok: true }> {
    if (providedSecret !== this.secret) {
      throw new UnauthorizedException();
    }
    await this.bot.handleUpdate(update);
    return { ok: true };
  }
}
