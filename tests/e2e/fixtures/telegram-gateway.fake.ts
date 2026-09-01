import type { NotificationIntent } from '@volley/application';
import type { TelegramId } from '@volley/domain';

export interface FakePrivateMessage {
  text: string;
  buttons: string[];
}

export class FakeTelegramGateway {
  private readonly privateMessages = new Map<
    TelegramId,
    FakePrivateMessage[]
  >();
  public readonly groupMessages: Array<{ chatId: TelegramId; text: string }> =
    [];

  public async getChatMember(): Promise<{ status: 'creator' }> {
    return { status: 'creator' };
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
  }
}
