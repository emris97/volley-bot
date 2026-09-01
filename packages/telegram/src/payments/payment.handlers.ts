import type {
  ChangeChargeStatus,
  FinalizeSettlement,
  PreviewSettlement,
  PreviewSettlementResult,
  SendPaymentReminders,
  Settlement,
  SettlementCommand,
  SettlementChargeRecord,
} from '@volley/application';
import type { GameId, GroupId, TelegramId, UserId } from '@volley/domain';

export interface PaymentActorResolver {
  resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<{ groupId: GroupId; gameId: GameId; userId: UserId }>;
}

export interface PaymentView {
  text: string;
  buttons: readonly { text: string; callbackData: string }[];
}

interface PrivatePaymentInput {
  telegramUserId: TelegramId;
  gameId: GameId;
  privateChat: boolean;
}

interface SettlementFlowInput extends PrivatePaymentInput {
  attendanceRevision: number;
  totalAmount: string;
  currency: 'RUB';
  roundingMode: SettlementCommand['roundingMode'];
}

export class PaymentHandlers {
  public constructor(
    private readonly actors: PaymentActorResolver,
    private readonly previewSettlement: Pick<PreviewSettlement, 'execute'>,
    private readonly finalizeSettlement: Pick<FinalizeSettlement, 'execute'>,
    private readonly changeChargeStatus: Pick<ChangeChargeStatus, 'execute'>,
    private readonly sendPaymentReminders: Pick<
      SendPaymentReminders,
      'execute'
    >,
  ) {}

  public start(input: PrivatePaymentInput): PaymentView {
    requirePrivateChat(input.privateChat);
    return {
      text: 'Введите общую сумму в рублях, например 2800.00',
      buttons: [],
    };
  }

  public async preview(input: SettlementFlowInput): Promise<PaymentView> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    const preview = await this.previewSettlement.execute(
      toSettlementCommand(input, actor),
    );
    return renderPreview(preview);
  }

  public async confirm(input: SettlementFlowInput): Promise<PaymentView> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    const settlement = await this.finalizeSettlement.execute(
      toSettlementCommand(input, actor),
    );
    return renderSettlement(settlement);
  }

  public async changeStatus(
    input: PrivatePaymentInput & {
      chargeId: string;
      status: SettlementChargeRecord['status'];
    },
  ): Promise<SettlementChargeRecord> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    return this.changeChargeStatus.execute({
      groupId: actor.groupId,
      chargeId: input.chargeId,
      actorUserId: actor.userId,
      status: input.status,
    });
  }

  public async sendReminders(
    input: PrivatePaymentInput & {
      chargeIds: readonly string[];
    },
  ): Promise<{ enqueued: number }> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    return this.sendPaymentReminders.execute({
      groupId: actor.groupId,
      actorUserId: actor.userId,
      chargeIds: input.chargeIds,
    });
  }
}

const requirePrivateChat = (privateChat: boolean): void => {
  if (!privateChat) throw new Error('Private chat required');
};

const toSettlementCommand = (
  input: SettlementFlowInput,
  actor: { groupId: GroupId; gameId: GameId; userId: UserId },
): SettlementCommand => {
  if (actor.gameId !== input.gameId) {
    throw new Error('Payment actor identity mismatch');
  }
  return {
    groupId: actor.groupId,
    gameId: actor.gameId,
    actorUserId: actor.userId,
    attendanceRevision: input.attendanceRevision,
    totalAmount: input.totalAmount,
    currency: input.currency,
    roundingMode: input.roundingMode,
  };
};

const formatMinor = (amountMinor: bigint): string => {
  const whole = amountMinor / 100n;
  const fraction = (amountMinor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
};

const renderPreview = (preview: PreviewSettlementResult): PaymentView => ({
  text: [
    `Предпросмотр: ${preview.participantCount} участников`,
    ...preview.charges.map(
      (charge) =>
        `${charge.displayName}: ${formatMinor(charge.amountMinor)} RUB`,
    ),
    `К оплате: ${formatMinor(preview.totalMinor)} RUB`,
    `Будет собрано: ${formatMinor(preview.collectedMinor)} RUB`,
    `Излишек: ${formatMinor(preview.surplusMinor)} RUB`,
  ].join('\n'),
  buttons: [{ text: 'Подтвердить', callbackData: 'payment:confirm' }],
});

const renderSettlement = (settlement: Settlement): PaymentView => ({
  text: [
    `Расчёт #${settlement.revision}`,
    ...settlement.charges.map(
      (charge) =>
        `${charge.displayName}: ${formatMinor(charge.amountMinor)} RUB — ${charge.status}`,
    ),
  ].join('\n'),
  buttons: settlement.charges.flatMap((charge) => [
    {
      text: 'Оплачено',
      callbackData: `payment:status:${charge.id}:PAID`,
    },
    {
      text: 'Не оплачено',
      callbackData: `payment:status:${charge.id}:UNPAID`,
    },
    {
      text: 'Оплата не требуется',
      callbackData: `payment:status:${charge.id}:WAIVED`,
    },
  ]),
});
