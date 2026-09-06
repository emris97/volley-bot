import type {
  ConfirmTentative,
  WithdrawRegistration,
} from '@volley/application';
import {
  asRegistrationId,
  type GameId,
  type GroupId,
  type RegistrationId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { toTelegramId } from '../group-onboarding.handlers.js';

export interface TentativeActorResolver {
  resolve(
    registrationId: RegistrationId,
    telegramUserId: TelegramId,
  ): Promise<{ groupId: GroupId; gameId: GameId; userId: UserId }>;
}

export class TentativeHandlers {
  public constructor(
    private readonly actors: TentativeActorResolver,
    private readonly confirm: Pick<ConfirmTentative, 'execute'>,
    private readonly withdraw: Pick<WithdrawRegistration, 'execute'>,
  ) {}

  public async handle(input: {
    telegramUserId: TelegramId;
    data: string;
  }): Promise<void> {
    const callback = parseTentativeCallback(input.data);
    const actor = await this.actors.resolve(
      callback.registrationId,
      input.telegramUserId,
    );
    if (callback.action === 'confirm') {
      await this.confirm.execute({
        ...actor,
        registrationId: callback.registrationId,
        actorUserId: actor.userId,
        expectedConfirmationRevision: callback.confirmationRevision,
      });
      return;
    }
    await this.withdraw.execute({
      ...actor,
      registrationId: callback.registrationId,
      actorUserId: actor.userId,
      reason: 'TENTATIVE_DECLINED',
      expectedConfirmationRevision: callback.confirmationRevision,
    });
  }
}

export const registerTentativeHandlers = (
  bot: Bot<Context>,
  handlers: TentativeHandlers,
): Bot<Context> => {
  bot.callbackQuery(/^tc:/, async (context) => {
    await handlers.handle({
      telegramUserId: toTelegramId(context.callbackQuery.from.id),
      data: context.callbackQuery.data,
    });
    await context.answerCallbackQuery({ text: 'Регистрация обновлена.' });
  });
  return bot;
};

export const tentativeCallback = (
  registrationId: RegistrationId,
  confirmationRevision: number,
  action: 'confirm' | 'withdraw',
): string => {
  if (!canonicalUuidPattern.test(registrationId)) {
    throw new Error('Invalid tentative callback registration id');
  }
  if (
    !Number.isSafeInteger(confirmationRevision) ||
    confirmationRevision < 0 ||
    confirmationRevision > 2_147_483_647
  ) {
    throw new Error('Invalid tentative callback revision');
  }
  return `tc:${action === 'confirm' ? 'y' : 'n'}:${confirmationRevision.toString(36)}:${registrationId}`;
};

const parseTentativeCallback = (value: string) => {
  const [prefix, action, revision, registrationId, ...rest] = value.split(':');
  const confirmationRevision = Number.parseInt(revision ?? '', 36);
  if (
    prefix !== 'tc' ||
    (action !== 'y' && action !== 'n') ||
    revision === undefined ||
    !/^(?:0|[1-9a-z][0-9a-z]*)$/.test(revision) ||
    !Number.isSafeInteger(confirmationRevision) ||
    confirmationRevision < 0 ||
    confirmationRevision > 2_147_483_647 ||
    confirmationRevision.toString(36) !== revision ||
    registrationId === undefined ||
    !canonicalUuidPattern.test(registrationId) ||
    rest.length > 0
  ) {
    throw new Error('Invalid tentative callback');
  }
  return {
    action: action === 'y' ? ('confirm' as const) : ('withdraw' as const),
    confirmationRevision,
    registrationId: asRegistrationId(registrationId),
  };
};

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
