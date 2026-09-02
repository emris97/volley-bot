import type { TelegramId, UserId } from '@volley/domain';

export interface AuthenticatedPrincipal {
  userId: UserId;
  telegramUserId: TelegramId;
  source: 'TELEGRAM_BOT' | 'MINI_APP' | 'WEB';
}
