import type { TelegramId } from '@volley/domain';

export type TelegramMemberStatus =
  'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

export interface TelegramGateway {
  getChatMember(
    chatId: TelegramId,
    userId: TelegramId,
  ): Promise<{ status: TelegramMemberStatus }>;
  sendMessage(chatId: TelegramId, message: string): Promise<void>;
}
