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
    await context.answerCallbackQuery({ text: 'registration:updated' });
  });
  return bot;
};

export const tentativeCallback = (
  registrationId: RegistrationId,
  confirmationRevision: number,
  action: 'confirm' | 'withdraw',
): string =>
  `tc:${action === 'confirm' ? 'y' : 'n'}:${confirmationRevision}:${registrationId}`;

const parseTentativeCallback = (value: string) => {
  const [prefix, action, revision, registrationId, ...rest] = value.split(':');
  if (
    prefix !== 'tc' ||
    (action !== 'y' && action !== 'n') ||
    revision === undefined ||
    !/^\d+$/.test(revision) ||
    registrationId === undefined ||
    rest.length > 0
  ) {
    throw new Error('Invalid tentative callback');
  }
  return {
    action: action === 'y' ? ('confirm' as const) : ('withdraw' as const),
    confirmationRevision: Number(revision),
    registrationId: asRegistrationId(registrationId),
  };
};
