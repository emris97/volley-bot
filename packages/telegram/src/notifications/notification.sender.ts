import {
  notificationTarget,
  type NotificationIntent,
} from '@volley/application';
import type { TelegramId } from '@volley/domain';
import { renderNotification } from './notification.renderer.js';

export class TelegramPrivateChatUnavailableError extends Error {
  public constructor(message = 'Telegram private chat is unavailable') {
    super(message);
    this.name = 'TelegramPrivateChatUnavailableError';
  }
}

export interface NotificationTelegramGateway {
  sendPrivate(
    telegramUserId: TelegramId,
    text: string,
    buttons: NotificationIntent['buttons'],
  ): Promise<void>;
  sendGroupMessage(groupChatId: TelegramId, text: string): Promise<void>;
}

export interface DirectMessageAvailability {
  markUnavailable(telegramUserId: TelegramId): Promise<void>;
}

interface PendingFallback {
  intent: NotificationIntent;
  telegramUserId: TelegramId;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class NotificationSender {
  private readonly pending = new Map<string, PendingFallback[]>();

  public constructor(
    private readonly telegram: NotificationTelegramGateway,
    private readonly availability: DirectMessageAvailability,
  ) {}

  public async send(intent: NotificationIntent): Promise<void> {
    const destination = notificationTarget(intent.recipient);
    const rendered = renderNotification(intent);
    try {
      await this.telegram.sendPrivate(
        destination.telegramUserId,
        rendered.text,
        rendered.buttons,
      );
    } catch (error) {
      if (!(error instanceof TelegramPrivateChatUnavailableError)) throw error;
      await this.availability.markUnavailable(destination.telegramUserId);
      await this.enqueueFallback(intent, destination.telegramUserId);
    }
  }

  private enqueueFallback(
    intent: NotificationIntent,
    telegramUserId: TelegramId,
  ): Promise<void> {
    const key = `${intent.groupId}:${intent.gameId}:${intent.notificationType}`;
    const existing = this.pending.get(key);
    const first = existing === undefined;
    const entries = existing ?? [];
    this.pending.set(key, entries);
    const result = new Promise<void>((resolve, reject) => {
      entries.push({ intent, telegramUserId, resolve, reject });
    });
    if (first) queueMicrotask(() => void this.flush(key));
    return result;
  }

  private async flush(key: string): Promise<void> {
    const entries = this.pending.get(key) ?? [];
    this.pending.delete(key);
    if (entries.length === 0) return;
    const mentions = entries.map(
      ({ intent, telegramUserId }) =>
        `<a href="tg://user?id=${telegramUserId}">${escapeHtml(intent.recipient.displayName)}</a>`,
    );
    try {
      await this.telegram.sendGroupMessage(
        entries[0]!.intent.groupChatId,
        `${mentions.join(', ')} — ${escapeHtml(entries[0]!.intent.text)}`,
      );
      entries.forEach((entry) => entry.resolve());
    } catch (error) {
      entries.forEach((entry) => entry.reject(error));
    }
  }
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
