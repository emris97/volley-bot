import {
  ExpireTentative,
  type MetricsRegistry,
  type NotificationIntent,
  type RequiredJob,
} from '@volley/application';
import type { GameId, GroupId, RegistrationId } from '@volley/domain';
import type {
  GameEventNotificationRecipientRecord,
  NotificationRecipientRecord,
  RegistrationRepository,
} from '@volley/persistence';
import {
  gameCancelledNotificationText,
  gameChangedNotificationText,
  NotificationSender,
  tentativeCallback,
} from '@volley/telegram';

export interface NotificationRecipientRepository {
  listTentative(
    groupId: GroupId,
    gameId: GameId,
    scheduleRevision: number,
  ): Promise<readonly NotificationRecipientRecord[]>;
  listRostered(
    groupId: GroupId,
    gameId: GameId,
    scheduleRevision: number,
  ): Promise<readonly NotificationRecipientRecord[]>;
  listActiveForGame(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly GameEventNotificationRecipientRecord[]>;
  findByRegistration(
    registrationId: RegistrationId,
  ): Promise<NotificationRecipientRecord | null>;
  claimDelivery(
    deterministicJobId: string,
    registrationId: RegistrationId,
  ): Promise<
    | { status: 'CLAIMED'; claimToken: string }
    | { status: 'DELIVERED' }
    | { status: 'BUSY' }
  >;
  markDelivered(
    deterministicJobId: string,
    registrationId: RegistrationId,
    claimToken: string,
  ): Promise<void>;
  releaseDelivery(
    deterministicJobId: string,
    registrationId: RegistrationId,
    claimToken: string,
  ): Promise<void>;
}

export class NotificationConsumer {
  private readonly expire: ExpireTentative;

  public constructor(
    private readonly recipients: NotificationRecipientRepository,
    private readonly sender: NotificationSender,
    registrations: Pick<RegistrationRepository, 'expireTentative'>,
    private readonly metrics?: MetricsRegistry,
  ) {
    this.expire = new ExpireTentative(registrations);
  }

  public async process(job: RequiredJob): Promise<void> {
    if (job.kind === 'REQUEST_TENTATIVE_CONFIRMATION') {
      const recipients = await this.recipients.listTentative(
        job.groupId,
        job.gameId,
        job.scheduleRevision,
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
        job.scheduleRevision,
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
        job.scheduleRevision,
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

  public async processGameEvent(
    eventType: string,
    payload: Record<string, unknown>,
    deterministicJobId: string,
  ): Promise<void> {
    const notificationType = gameEventNotificationType(eventType, payload);
    if (notificationType === null) return;
    const groupId = asPayloadGroupId(payload.groupId);
    const gameId = asPayloadGameId(payload.aggregateId);
    const recipients = await this.recipients.listActiveForGame(groupId, gameId);
    if (recipients.length === 0) return;
    const text =
      notificationType === 'GAME_CANCELLED'
        ? gameCancelledNotificationText(recipients[0]!.game.name)
        : gameChangedText(payload);
    await Promise.all(
      recipients.map((recipient) =>
        this.sendOnce(
          deterministicJobId,
          recipient,
          intentFor(recipient, {
            notificationType,
            text,
            buttons: [],
          }),
        ),
      ),
    );
  }

  private async sendOnce(
    deterministicJobId: string,
    recipient: NotificationRecipientRecord,
    intent: NotificationIntent,
  ): Promise<void> {
    // Telegram sendMessage has no caller-supplied idempotency key. This lease
    // prevents concurrent and acknowledged duplicates; a process crash after
    // Telegram accepts the message but before markDelivered remains at-least-once.
    const claim = await this.recipients.claimDelivery(
      deterministicJobId,
      recipient.registrationId,
    );
    if (claim.status === 'DELIVERED') return;
    if (claim.status === 'BUSY') {
      throw new Error('Notification delivery is already claimed');
    }
    try {
      await this.sender.send(intent);
      await this.recipients.markDelivered(
        deterministicJobId,
        recipient.registrationId,
        claim.claimToken,
      );
    } catch (error) {
      this.metrics?.recordNotificationFailure('private');
      await this.recipients.releaseDelivery(
        deterministicJobId,
        recipient.registrationId,
        claim.claimToken,
      );
      throw error;
    }
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

const gameEventNotificationType = (
  eventType: string,
  payload: Record<string, unknown>,
): 'GAME_CHANGED' | 'GAME_CANCELLED' | null => {
  if (
    eventType === 'GAME_UPDATED' &&
    Array.isArray(payload.materialFields) &&
    payload.materialFields.length > 0
  ) {
    return 'GAME_CHANGED';
  }
  if (eventType === 'GAME_STATE_CHANGED' && payload.to === 'CANCELLED') {
    return 'GAME_CANCELLED';
  }
  return null;
};

const gameChangedText = (payload: Record<string, unknown>): string => {
  const before = payloadDisplaySnapshot(payload, 'displayBefore');
  const after = payloadDisplaySnapshot(payload, 'displayAfter');
  return gameChangedNotificationText({
    name: after.name,
    timeZone: after.timeZone,
    before,
    after,
  });
};

interface DisplaySnapshot {
  name: string;
  startsAt: Date;
  venue: string;
  address: string | null;
  timeZone: string;
}

const payloadDisplaySnapshot = (
  payload: Record<string, unknown>,
  field: string,
): DisplaySnapshot => {
  const value = payload[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Game event ${field} is required`);
  }
  const snapshot = value as Record<string, unknown>;
  return {
    name: payloadString(snapshot, 'name', field),
    startsAt: payloadDate(snapshot, 'startsAt', field),
    venue: payloadString(snapshot, 'venue', field),
    address: payloadNullableString(snapshot, 'address', field),
    timeZone: payloadString(snapshot, 'timeZone', field),
  };
};

const payloadDate = (
  payload: Record<string, unknown>,
  field: string,
  parent?: string,
): Date => {
  const value = payloadString(payload, field, parent);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Game event ${payloadPath(parent, field)} is invalid`);
  }
  return date;
};

const payloadString = (
  payload: Record<string, unknown>,
  field: string,
  parent?: string,
): string => {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new Error(`Game event ${payloadPath(parent, field)} is required`);
  }
  return value;
};

const payloadNullableString = (
  payload: Record<string, unknown>,
  field: string,
  parent?: string,
): string | null => {
  const value = payload[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Game event ${payloadPath(parent, field)} is required`);
  }
  return value;
};

const payloadPath = (parent: string | undefined, field: string): string =>
  parent === undefined ? field : `${parent}.${field}`;

const asPayloadGroupId = (value: unknown): GroupId => {
  if (typeof value !== 'string')
    throw new Error('Game event group is required');
  return value as GroupId;
};

const asPayloadGameId = (value: unknown): GameId => {
  if (typeof value !== 'string') throw new Error('Game event game is required');
  return value as GameId;
};
