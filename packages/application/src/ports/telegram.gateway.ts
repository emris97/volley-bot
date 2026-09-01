import type { TelegramId } from '@volley/domain';

export type TelegramMemberStatus =
  'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

export interface TelegramGateway {
  getChatMember(
    chatId: TelegramId,
    userId: TelegramId,
  ): Promise<{ status: TelegramMemberStatus }>;
  sendMessage(
    chatId: TelegramId,
    message: string,
    options?: {
      parseMode?: 'HTML';
      keyboard?: readonly (readonly {
        text: string;
        callbackData: string;
      }[])[];
    },
  ): Promise<void | { messageId: bigint }>;
  editMessage?(
    chatId: TelegramId,
    messageId: bigint,
    message: string,
    options?: {
      parseMode?: 'HTML';
      keyboard?: readonly (readonly {
        text: string;
        callbackData: string;
      }[])[];
    },
  ): Promise<void>;
  pinMessage?(chatId: TelegramId, messageId: bigint): Promise<void>;
}
