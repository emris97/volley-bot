import type { NotificationIntent } from '@volley/application';

export const renderNotification = (
  intent: NotificationIntent,
): { text: string; buttons: NotificationIntent['buttons'] } => ({
  text:
    intent.recipient.kind === 'GUEST'
      ? `${intent.recipient.displayName}: ${intent.text}`
      : intent.text,
  buttons: intent.buttons,
});
