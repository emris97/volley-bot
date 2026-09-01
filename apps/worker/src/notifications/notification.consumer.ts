import {
  ExpireTentative,
  type NotificationIntent,
  type RequiredJob,
} from '@volley/application';
import type { GameId, GroupId } from '@volley/domain';
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
          this.sender.send(
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
          this.sender.send(
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
