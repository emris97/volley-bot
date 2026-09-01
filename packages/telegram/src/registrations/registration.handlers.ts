import type {
  RegisterParticipant,
  RegistrationMembershipResolver,
  RegistrationResult,
  WithdrawRegistration,
} from '@volley/application';
import type {
  GameId,
  GroupId,
  RegistrationId,
  TelegramId,
  UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { CallbackCodec } from '../callbacks/callback-codec.js';
import { toTelegramId } from '../group-onboarding.handlers.js';
import type { TelegramGateway } from '@volley/application';

export interface RegistrationActor {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  activeRegistrationId: RegistrationId | null;
}

export interface RegistrationActorResolver {
  resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<RegistrationActor>;
}

export interface GuestLinkFactory {
  create(gameId: GameId, inviterTelegramId: TelegramId): string;
}

export interface RegistrationIdentityDirectory {
  findTelegramIdentity(
    groupId: GroupId,
    userId: UserId,
  ): Promise<{ telegramChatId: TelegramId; telegramUserId: TelegramId } | null>;
}

export class TelegramMembershipResolver implements RegistrationMembershipResolver {
  public constructor(
    private readonly telegram: TelegramGateway,
    private readonly identities: RegistrationIdentityDirectory,
  ) {}

  public async priorityFor(groupId: GroupId, userId: UserId): Promise<number> {
    const identity = await this.identities.findTelegramIdentity(
      groupId,
      userId,
    );
    if (identity === null) throw new Error('Telegram identity not found');
    const member = await this.telegram.getChatMember(
      identity.telegramChatId,
      identity.telegramUserId,
    );
    if (member.status === 'left' || member.status === 'kicked') {
      throw new Error('Current Telegram group membership is required');
    }
    return 1;
  }
}

type RegistrationUseCase = Pick<RegisterParticipant, 'execute'>;
type WithdrawalUseCase = Pick<WithdrawRegistration, 'execute'>;

export class RegistrationHandlers {
  public constructor(
    private readonly codec: CallbackCodec,
    private readonly actors: RegistrationActorResolver,
    private readonly register: RegistrationUseCase,
    private readonly withdraw: WithdrawalUseCase,
    private readonly guestLinks?: GuestLinkFactory,
  ) {}

  public async handleCallback(input: {
    telegramUserId: TelegramId;
    updateId: number;
    data: string;
  }): Promise<string> {
    const callback = this.codec.decode(input.data);
    const actor = await this.actors.resolve(
      callback.gameId,
      input.telegramUserId,
    );
    if (callback.action === 'GOING' || callback.action === 'TENTATIVE') {
      const result = await this.register.execute({
        groupId: actor.groupId,
        gameId: actor.gameId,
        userId: actor.userId,
        intent: callback.action === 'GOING' ? 'CONFIRMED' : 'TENTATIVE',
        idempotencyKey: `callback:${input.updateId}`,
      });
      return statusText(result);
    }
    if (callback.action === 'WITHDRAW') {
      if (actor.activeRegistrationId === null) {
        throw new Error('No active registration for this game');
      }
      const result = await this.withdraw.execute({
        groupId: actor.groupId,
        gameId: actor.gameId,
        registrationId: actor.activeRegistrationId,
        actorUserId: actor.userId,
      });
      return statusText(result);
    }
    if (callback.action === 'ADD_GUEST') {
      return (
        this.guestLinks?.create(actor.gameId, input.telegramUserId) ??
        `registration:add-guest:${actor.gameId}`
      );
    }
    throw new Error('Unsupported registration callback');
  }
}

export const registerRegistrationHandlers = (
  bot: Bot<Context>,
  handlers: RegistrationHandlers,
): Bot<Context> => {
  bot.callbackQuery(/^v1:/, async (context) => {
    const text = await handlers.handleCallback({
      telegramUserId: toTelegramId(context.callbackQuery.from.id),
      updateId: context.update.update_id,
      data: context.callbackQuery.data,
    });
    if (text.startsWith('https://')) {
      await context.reply(text);
      await context.answerCallbackQuery({ text: 'registration:open-private' });
    } else {
      await context.answerCallbackQuery({ text });
    }
  });
  return bot;
};

const statusText = (result: RegistrationResult): string => {
  if (result.state === 'ROSTERED') {
    return `registration:rostered:${result.rosterPosition ?? ''}`;
  }
  if (result.state === 'WAITLISTED') {
    return `registration:waitlisted:${result.waitlistPosition ?? ''}`;
  }
  return `registration:${result.state.toLowerCase()}`;
};
