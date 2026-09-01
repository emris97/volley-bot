import type { JsonLogger, MetricsRegistry } from '@volley/application';
import type {
  PaymentReminderRepository,
  StoredPaymentReminderRecipient,
} from '@volley/persistence';
import {
  PaymentReminderSender,
  TelegramPrivateChatUnavailableError,
} from '@volley/telegram';
import { observeWorkerJob } from '../observability/worker-job-observability.js';

type PaymentReminderStore = Pick<
  PaymentReminderRepository,
  | 'claimDelivery'
  | 'findRecipient'
  | 'markDelivered'
  | 'markTerminalFailure'
  | 'releaseDelivery'
  | 'markUnavailable'
>;

type PaymentReminderDelivery = Pick<PaymentReminderSender, 'send'>;

export class PaymentReminderConsumer {
  public constructor(
    private readonly repository: PaymentReminderStore,
    private readonly sender: PaymentReminderDelivery,
    private readonly metrics?: MetricsRegistry,
    private readonly logger?: JsonLogger,
  ) {}

  public async process(
    payload: Record<string, unknown>,
    deterministicJobId: string,
    attemptsMade = 0,
  ): Promise<void> {
    return observeWorkerJob(
      this.metrics,
      this.logger,
      {
        queue: 'payment-reminders',
        jobId: deterministicJobId,
        groupId:
          typeof payload.groupId === 'string' ? payload.groupId : undefined,
        gameId: typeof payload.gameId === 'string' ? payload.gameId : undefined,
        attemptsMade,
      },
      () => this.processDelivery(payload, deterministicJobId),
    );
  }

  private async processDelivery(
    payload: Record<string, unknown>,
    deterministicJobId: string,
  ): Promise<void> {
    const identity = parsePayload(payload);
    const claim = await this.repository.claimDelivery(
      deterministicJobId,
      identity.chargeId,
    );
    if (claim.status === 'COMPLETED') return;
    if (claim.status === 'BUSY') {
      throw new Error('Payment reminder delivery is already claimed');
    }
    try {
      const recipient = await this.repository.findRecipient(identity);
      if (recipient === null) {
        await this.repository.markTerminalFailure(
          deterministicJobId,
          identity.chargeId,
          claim.claimToken,
          'NO_PRIVATE_RECIPIENT',
        );
        return;
      }
      await this.sendClaimed(
        recipient,
        deterministicJobId,
        identity.chargeId,
        claim.claimToken,
      );
    } catch (error) {
      await this.repository.releaseDelivery(
        deterministicJobId,
        identity.chargeId,
        claim.claimToken,
      );
      throw error;
    }
  }

  private async sendClaimed(
    recipient: StoredPaymentReminderRecipient,
    deterministicJobId: string,
    chargeId: string,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.sender.send(recipient);
      await this.repository.markDelivered(
        deterministicJobId,
        chargeId,
        claimToken,
      );
    } catch (error) {
      this.metrics?.recordNotificationFailure('private');
      if (error instanceof TelegramPrivateChatUnavailableError) {
        await this.repository.markUnavailable(recipient.userId);
        await this.repository.markTerminalFailure(
          deterministicJobId,
          chargeId,
          claimToken,
          'PRIVATE_CHAT_UNAVAILABLE',
        );
        return;
      }
      throw error;
    }
  }
}

const parsePayload = (
  payload: Record<string, unknown>,
): { groupId: string; chargeId: string; settlementId: string } => {
  if (
    payload.channel !== 'PRIVATE' ||
    typeof payload.groupId !== 'string' ||
    typeof payload.chargeId !== 'string' ||
    typeof payload.settlementId !== 'string'
  ) {
    throw new Error('Private payment reminder identity is required');
  }
  return {
    groupId: payload.groupId,
    chargeId: payload.chargeId,
    settlementId: payload.settlementId,
  };
};
