import type { NotificationIntent } from '@volley/application';
import type { TelegramId } from '@volley/domain';

export interface FakePrivateMessage {
  text: string;
  buttons: string[];
  buttonCallbacks: Array<{ text: string; callbackData: string }>;
}

export class FakeTelegramGateway {
  private readonly privateMessages = new Map<
    TelegramId,
    FakePrivateMessage[]
  >();
  public readonly groupMessages: Array<{ chatId: TelegramId; text: string }> =
    [];
  private readonly memberships = new Map<
    string,
    'creator' | 'administrator' | 'member' | 'left'
  >();

  public async getChatMember(
    chatId: TelegramId,
    telegramUserId: TelegramId,
  ): Promise<{
    status: 'creator' | 'administrator' | 'member' | 'left';
  }> {
    return {
      status: this.memberships.get(`${chatId}:${telegramUserId}`) ?? 'creator',
    };
  }

  public setChatMember(
    chatId: TelegramId,
    telegramUserId: TelegramId,
    status: 'creator' | 'administrator' | 'member' | 'left',
  ): void {
    this.memberships.set(`${chatId}:${telegramUserId}`, status);
  }

  public async sendPrivate(
    telegramUserId: TelegramId,
    text: string,
    buttons: NotificationIntent['buttons'],
  ): Promise<void> {
    const messages = this.privateMessages.get(telegramUserId) ?? [];
    messages.push({
      text,
      buttons: buttons.map((button) =>
        typeof button === 'string' ? button : button.text,
      ),
      buttonCallbacks: buttons.flatMap((button) =>
        typeof button === 'string' ? [] : [button],
      ),
    });
    this.privateMessages.set(telegramUserId, messages);
  }

  public async sendGroupMessage(
    chatId: TelegramId,
    text: string,
  ): Promise<void> {
    this.groupMessages.push({ chatId, text });
  }

  public privateMessagesFor(
    telegramUserId: TelegramId,
  ): readonly FakePrivateMessage[] {
    return this.privateMessages.get(telegramUserId) ?? [];
  }

  public clear(): void {
    this.privateMessages.clear();
    this.groupMessages.length = 0;
    this.memberships.clear();
  }
}
