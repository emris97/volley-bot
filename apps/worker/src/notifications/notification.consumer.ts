import {
  ExpireTentative,
  type NotificationIntent,
  type RequiredJob,
} from '@volley/application';
import type { GameId, GroupId, RegistrationId } from '@volley/domain';
import type {
  NotificationRecipientRecord,
  RegistrationRepository,
} from '@volley/persistence';
import { NotificationSender, tentativeCallback } from '@volley/telegram';

export interface NotificationRecipientRepository {
  listTentative(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly NotificationRecipientRecord[]>;
  listRostered(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly NotificationRecipientRecord[]>;
  findByRegistration(
    registrationId: RegistrationId,
  ): Promise<NotificationRecipientRecord | null>;
  wasDelivered(
    deterministicJobId: string,
    registrationId: RegistrationId,
  ): Promise<boolean>;
  markDelivered(
    deterministicJobId: string,
    registrationId: RegistrationId,
  ): Promise<void>;
}

export class NotificationConsumer {
  private readonly expire: ExpireTentative;

  public constructor(
    private readonly recipients: NotificationRecipientRepository,
    private readonly sender: NotificationSender,
    registrations: Pick<RegistrationRepository, 'expireTentative'>,
  ) {
    this.expire = new ExpireTentative(registrations);
  }

  public async process(job: RequiredJob): Promise<void> {
    if (job.kind === 'REQUEST_TENTATIVE_CONFIRMATION') {
      const recipients = await this.recipients.listTentative(
        job.groupId,
        job.gameId,
      );
      await Promise.all(
        recipients.map((recipient) =>
          this.sendOnce(
            job.id,
            recipient,
            intentFor(recipient, {
              notificationType: 'TENTATIVE_CONFIRMATION',
              text: 'Подтвердите участие в игре',
              buttons: [
                {
                  text: 'Подтверждаю',
                  callbackData: tentativeCallback(
                    recipient.registrationId,
                    recipient.confirmationRevision,
                    'confirm',
                  ),
                },
                {
                  text: 'Снимаюсь',
                  callbackData: tentativeCallback(
                    recipient.registrationId,
                    recipient.confirmationRevision,
                    'withdraw',
                  ),
                },
              ],
            }),
          ),
        ),
      );
      return;
    }
    if (job.kind === 'EXPIRE_TENTATIVE') {
      const recipients = await this.recipients.listTentative(
        job.groupId,
        job.gameId,
      );
      await Promise.all(
        recipients.map((recipient) =>
          this.expire.execute({
            groupId: recipient.groupId,
            gameId: recipient.gameId,
            registrationId: recipient.registrationId,
            expectedConfirmationRevision: recipient.confirmationRevision,
          }),
        ),
      );
      return;
    }
    if (job.kind === 'REMIND_PARTICIPANTS') {
      const recipients = await this.recipients.listRostered(
        job.groupId,
        job.gameId,
      );
      await Promise.all(
        recipients.map((recipient) =>
          this.sendOnce(
            job.id,
            recipient,
            intentFor(recipient, {
              notificationType: 'PARTICIPANT_REMINDER',
              text: 'Напоминание: игра скоро начнётся',
              buttons: [],
            }),
          ),
        ),
      );
    }
  }

  private async sendOnce(
    deterministicJobId: string,
    recipient: NotificationRecipientRecord,
    intent: NotificationIntent,
  ): Promise<void> {
    if (
      await this.recipients.wasDelivered(
        deterministicJobId,
        recipient.registrationId,
      )
    ) {
      return;
    }
    await this.sender.send(intent);
    await this.recipients.markDelivered(
      deterministicJobId,
      recipient.registrationId,
    );
  }

  public async processWaitlistPromotion(
    registrationId: RegistrationId,
    deterministicEventId = `WAITLIST_PROMOTED:${registrationId}`,
  ): Promise<void> {
    const recipient = await this.recipients.findByRegistration(registrationId);
    if (recipient === null) return;
    await this.sendOnce(
      deterministicEventId,
      recipient,
      intentFor(recipient, {
        notificationType: 'WAITLIST_PROMOTED',
        text: 'Вы перешли из листа ожидания в основной состав',
        buttons: [],
      }),
    );
  }
}

const intentFor = (
  recipient: NotificationRecipientRecord,
  notification: Pick<
    NotificationIntent,
    'notificationType' | 'text' | 'buttons'
  >,
): NotificationIntent => ({
  ...notification,
  groupId: recipient.groupId,
  gameId: recipient.gameId,
  groupChatId: recipient.groupChatId,
  recipient: {
    kind: recipient.kind,
    telegramUserId: recipient.telegramUserId,
    inviterTelegramUserId: recipient.inviterTelegramUserId,
    displayName: recipient.displayName,
  },
});
