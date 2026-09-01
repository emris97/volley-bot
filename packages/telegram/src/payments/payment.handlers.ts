import type {
  ChangeChargeStatus,
  FinalizeSettlement,
  PaymentAuthorization,
  PaymentTelegramRepository,
  PreviewSettlement,
  PreviewSettlementResult,
  SendPaymentReminders,
  Settlement,
  SettlementCommand,
  SettlementChargeRecord,
} from '@volley/application';
import {
  asGameId,
  type GameId,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { toTelegramId } from '../group-onboarding.handlers.js';

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
    private readonly state: PaymentTelegramRepository,
    private readonly authorization: PaymentAuthorization,
  ) {}

  public async start(input: PrivatePaymentInput): Promise<PaymentView> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    await this.authorization.requireOrganizer(actor.groupId, actor.userId);
    await this.state.beginInput({
      groupId: actor.groupId,
      gameId: actor.gameId,
      actorUserId: actor.userId,
    });
    return {
      text: 'Введите общую сумму в рублях, например 2800.00',
      buttons: [],
    };
  }

  public async handleText(input: {
    telegramUserId: TelegramId;
    privateChat: boolean;
    text: string;
  }): Promise<PaymentView | null> {
    requirePrivateChat(input.privateChat);
    const session = await this.state.findInputByTelegramUserId(
      input.telegramUserId,
    );
    if (session === null) return null;
    const actor = await this.actors.resolve(
      session.gameId,
      input.telegramUserId,
    );
    if (
      actor.groupId !== session.groupId ||
      actor.userId !== session.actorUserId
    ) {
      throw new Error('Payment input identity mismatch');
    }
    const view = await this.preview({
      telegramUserId: input.telegramUserId,
      gameId: session.gameId,
      privateChat: true,
      attendanceRevision: session.attendanceRevision,
      totalAmount: input.text,
      currency: session.currency,
      roundingMode: session.roundingMode,
    });
    await this.state.clearInput(session.groupId, session.actorUserId);
    return view;
  }

  public async preview(input: SettlementFlowInput): Promise<PaymentView> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    const command = toSettlementCommand(input, actor);
    const preview = await this.previewSettlement.execute(command);
    const draft = await this.state.saveDraft({
      groupId: command.groupId,
      gameId: command.gameId,
      actorUserId: command.actorUserId,
      attendanceRevision: command.attendanceRevision,
      totalAmount: command.totalAmount,
      currency: command.currency,
      roundingMode: command.roundingMode,
    });
    return renderPreview(preview, command.gameId, draft.id);
  }

  public async confirm(input: SettlementFlowInput): Promise<PaymentView> {
    requirePrivateChat(input.privateChat);
    const actor = await this.actors.resolve(input.gameId, input.telegramUserId);
    const settlement = await this.finalizeSettlement.execute(
      toSettlementCommand(input, actor),
    );
    return renderSettlement(settlement, actor.gameId);
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

  public async handleCallback(input: {
    telegramUserId: TelegramId;
    privateChat: boolean;
    data: string;
  }): Promise<PaymentView> {
    requirePrivateChat(input.privateChat);
    const callback = parsePaymentCallback(input.data);
    const actor = await this.actors.resolve(
      callback.gameId,
      input.telegramUserId,
    );
    if (actor.gameId !== callback.gameId) {
      throw new Error('Payment actor identity mismatch');
    }

    if (callback.action === 'confirm') {
      const draft = await this.state.findDraft(actor.groupId, callback.draftId);
      if (
        draft === null ||
        draft.gameId !== actor.gameId ||
        draft.actorUserId !== actor.userId
      ) {
        throw new Error('Payment preview not found');
      }
      const settlement = await this.finalizeSettlement.execute({
        groupId: actor.groupId,
        gameId: actor.gameId,
        actorUserId: actor.userId,
        attendanceRevision: draft.attendanceRevision,
        totalAmount: draft.totalAmount,
        currency: draft.currency,
        roundingMode: draft.roundingMode,
        draftId: draft.id,
      });
      return renderSettlement(settlement, actor.gameId);
    }
    if (callback.action === 'status') {
      await this.changeChargeStatus.execute({
        groupId: actor.groupId,
        chargeId: callback.chargeId,
        actorUserId: actor.userId,
        status: callback.status,
      });
      return this.renderActiveSettlement(actor.groupId, actor.gameId);
    }
    const result = await this.sendPaymentReminders.execute({
      groupId: actor.groupId,
      actorUserId: actor.userId,
      chargeIds: [callback.chargeId],
    });
    const view = await this.renderActiveSettlement(actor.groupId, actor.gameId);
    return {
      ...view,
      text: `Напоминаний поставлено в очередь: ${result.enqueued}\n${view.text}`,
    };
  }

  private async renderActiveSettlement(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<PaymentView> {
    const settlement = await this.state.findActiveSettlement(groupId, gameId);
    if (settlement === null) throw new Error('Active settlement not found');
    return renderSettlement(settlement, gameId);
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

const renderPreview = (
  preview: PreviewSettlementResult,
  gameId: GameId,
  draftId: string,
): PaymentView => ({
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
  buttons: [
    {
      text: 'Подтвердить',
      callbackData: paymentCallback('confirm', gameId, draftId),
    },
  ],
});

const renderSettlement = (
  settlement: Settlement,
  gameId: GameId,
): PaymentView => ({
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
      callbackData: paymentCallback('status', gameId, charge.id, 'PAID'),
    },
    {
      text: 'Не оплачено',
      callbackData: paymentCallback('status', gameId, charge.id, 'UNPAID'),
    },
    {
      text: 'Оплата не требуется',
      callbackData: paymentCallback('status', gameId, charge.id, 'WAIVED'),
    },
    ...(charge.status === 'UNPAID' && !charge.addedManually
      ? [
          {
            text: 'Напомнить',
            callbackData: paymentCallback('remind', gameId, charge.id),
          },
        ]
      : []),
  ]),
});

type PaymentCallback =
  | { action: 'confirm'; gameId: GameId; draftId: string }
  | {
      action: 'status';
      gameId: GameId;
      chargeId: string;
      status: SettlementChargeRecord['status'];
    }
  | { action: 'remind'; gameId: GameId; chargeId: string };

const paymentCallback = (
  action: PaymentCallback['action'],
  gameId: GameId,
  entityId: string,
  status?: SettlementChargeRecord['status'],
): string => {
  const code =
    action === 'confirm'
      ? 'c'
      : action === 'remind'
        ? 'r'
        : status === 'PAID'
          ? 'p'
          : status === 'UNPAID'
            ? 'u'
            : status === 'WAIVED'
              ? 'w'
              : null;
  if (code === null) throw new Error('Invalid payment callback');
  const value = `pay:${code}:${compactUuid(gameId)}:${compactUuid(entityId)}`;
  if (Buffer.byteLength(value, 'utf8') > 64) {
    throw new Error('Telegram callback payload exceeds 64 bytes');
  }
  return value;
};

const parsePaymentCallback = (value: string): PaymentCallback => {
  const [prefix, code, compactGameId, compactEntityId, ...rest] =
    value.split(':');
  if (
    prefix !== 'pay' ||
    !['c', 'r', 'p', 'u', 'w'].includes(code ?? '') ||
    compactGameId === undefined ||
    compactEntityId === undefined ||
    rest.length > 0
  ) {
    throw new Error('Invalid payment callback');
  }
  const gameId = decodeCompactUuid(compactGameId) as GameId;
  const entityId = decodeCompactUuid(compactEntityId);
  if (code === 'c') return { action: 'confirm', gameId, draftId: entityId };
  if (code === 'r') return { action: 'remind', gameId, chargeId: entityId };
  return {
    action: 'status',
    gameId,
    chargeId: entityId,
    status: code === 'p' ? 'PAID' : code === 'u' ? 'UNPAID' : 'WAIVED',
  };
};

const compactUuid = (value: string): string => {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error('Invalid payment callback id');
  }
  return Buffer.from(hex, 'hex').toString('base64url');
};

const decodeCompactUuid = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error('Invalid payment callback');
  }
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) throw new Error('Invalid payment callback');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const registerPaymentHandlers = (
  bot: Bot<Context>,
  handlers: PaymentHandlers,
): Bot<Context> => {
  bot.command('payment', async (context) => {
    if (context.from === undefined)
      throw new Error('Message sender is required');
    const gameId = parseGameId(context.match ?? '');
    const view = await handlers.start({
      telegramUserId: toTelegramId(context.from.id),
      gameId,
      privateChat: context.chat.type === 'private',
    });
    await context.reply(view.text);
  });
  bot.on('message:text', async (context, next) => {
    if (
      context.chat.type !== 'private' ||
      context.from === undefined ||
      context.message.text.startsWith('/')
    ) {
      await next();
      return;
    }
    const view = await handlers.handleText({
      telegramUserId: toTelegramId(context.from.id),
      privateChat: context.chat.type === 'private',
      text: context.message.text,
    });
    if (view === null) {
      await next();
      return;
    }
    await context.reply(view.text, {
      reply_markup: {
        inline_keyboard: view.buttons.map((button) => [
          { text: button.text, callback_data: button.callbackData },
        ]),
      },
    });
  });
  bot.callbackQuery(/^pay:/, async (context) => {
    const view = await handlers.handleCallback({
      telegramUserId: toTelegramId(context.callbackQuery.from.id),
      privateChat: context.callbackQuery.message?.chat.type === 'private',
      data: context.callbackQuery.data,
    });
    await context.editMessageText(view.text, {
      reply_markup: {
        inline_keyboard: view.buttons.map((button) => [
          { text: button.text, callback_data: button.callbackData },
        ]),
      },
    });
    await context.answerCallbackQuery({ text: 'payment:updated' });
  });
  return bot;
};

const parseGameId = (value: string): GameId => {
  const trimmed = value.trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(trimmed)) {
    throw new Error('Valid game id required');
  }
  return asGameId(trimmed);
};
