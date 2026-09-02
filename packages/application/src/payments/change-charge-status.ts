import type {
  ChangeChargeStatusInput,
  PaymentAuthorization,
  PaymentRepository,
  SettlementChargeRecord,
} from './ports.js';

export class ChangeChargeStatus {
  public constructor(
    private readonly authorization: PaymentAuthorization,
    private readonly payments: PaymentRepository,
  ) {}

  public async execute(
    command: ChangeChargeStatusInput,
  ): Promise<SettlementChargeRecord> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    return this.payments.changeChargeStatus(command);
  }
}

export type ChangeChargeStatusCommand = ChangeChargeStatusInput;
