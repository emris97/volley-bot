import type { TelegramId } from '@volley/domain';

export interface PaymentReminderMessage {
  telegramUserId: TelegramId;
  displayName: string;
  amountMinor: bigint;
  currency: 'RUB';
}

export interface PaymentReminderTelegramGateway {
  sendPrivate(telegramUserId: TelegramId, text: string): Promise<void>;
}

export class PaymentReminderSender {
  public constructor(
    private readonly telegram: PaymentReminderTelegramGateway,
  ) {}

  public send(reminder: PaymentReminderMessage): Promise<void> {
    return this.telegram.sendPrivate(
      reminder.telegramUserId,
      `${reminder.displayName}, напоминание об оплате: ${formatMinor(reminder.amountMinor)} ${reminder.currency}`,
    );
  }
}

const formatMinor = (amountMinor: bigint): string =>
  `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, '0')}`;
