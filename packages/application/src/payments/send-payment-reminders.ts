import type {
  EnqueuePaymentRemindersInput,
  PaymentAuthorization,
  PaymentRepository,
} from './ports.js';

export class SendPaymentReminders {
  public constructor(
    private readonly authorization: PaymentAuthorization,
    private readonly payments: PaymentRepository,
  ) {}

  public async execute(
    command: EnqueuePaymentRemindersInput,
  ): Promise<{ enqueued: number }> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    if (command.chargeIds.length === 0) {
      throw new Error('At least one charge must be selected');
    }
    if (command.idempotencyKey.trim().length === 0) {
      throw new Error('Payment reminder idempotency key is required');
    }
    return this.payments.enqueueReminders(command);
  }
}

export type SendPaymentRemindersCommand = EnqueuePaymentRemindersInput;
