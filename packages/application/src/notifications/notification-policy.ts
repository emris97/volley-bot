import type { GameId, GroupId, TelegramId } from '@volley/domain';

export type NotificationTarget =
  'PRIVATE' | 'GROUP_MENTION' | 'INVITER_PRIVATE';
export type NotificationType =
  'TENTATIVE_CONFIRMATION' | 'PARTICIPANT_REMINDER' | 'WAITLIST_PROMOTED';

export interface NotificationRecipient {
  kind: 'MEMBER' | 'GUEST';
  telegramUserId: TelegramId | null;
  inviterTelegramUserId: TelegramId | null;
  displayName: string;
}

export interface NotificationIntent {
  notificationType: NotificationType;
  groupId: GroupId;
  gameId: GameId;
  groupChatId: TelegramId;
  recipient: NotificationRecipient;
  text: string;
  buttons: readonly (string | { text: string; callbackData: string })[];
}

export const notificationTarget = (
  recipient: NotificationRecipient,
): { target: NotificationTarget; telegramUserId: TelegramId } => {
  if (recipient.kind === 'GUEST') {
    if (recipient.inviterTelegramUserId === null) {
      throw new Error('Guest notification requires an inviter');
    }
    return {
      target: 'INVITER_PRIVATE',
      telegramUserId: recipient.inviterTelegramUserId,
    };
  }
  if (recipient.telegramUserId === null) {
    throw new Error('Member notification requires a Telegram identity');
  }
  return { target: 'PRIVATE', telegramUserId: recipient.telegramUserId };
};
