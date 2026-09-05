import {
  AuthorizationDeniedError,
  type TelegramGateway,
} from '@volley/application';
import type { TelegramId } from '@volley/domain';
import { Logger } from '@nestjs/common';
import { Bot, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import {
  GroupOnboardingHandlers,
  toTelegramId,
} from './group-onboarding.handlers.js';
import { OnboardingInputError } from './group-onboarding.model.js';
import {
  renderStartError,
  type StartErrorReason,
} from './group-onboarding.presenter.js';
import type { GuestFlowHandlers } from './registrations/guest-flow.handlers.js';
import { TelegramMessageNotEditableError } from './messages/game-message-updater.js';
import { StartTokenVerificationError } from './signed-start-token.js';

const logger = new Logger('TelegramBot');

export const createTelegramBot = (
  token: string,
  botInfo?: UserFromGetMe,
  handlers?: GroupOnboardingHandlers,
): Bot<Context> => {
  const bot = new Bot(token, botInfo === undefined ? {} : { botInfo });

  if (handlers !== undefined) registerGroupOnboardingHandlers(bot, handlers);
  return bot;
};

export const registerGroupOnboardingHandlers = (
  bot: Bot<Context>,
  handlers: GroupOnboardingHandlers,
  guestHandlers?: GuestFlowHandlers,
): Bot<Context> => {
  bot.on('my_chat_member', async (context) => {
    await handlers.handleMyChatMember({
      telegramChatId: toTelegramId(context.chat.id),
      actorTelegramId: toTelegramId(context.from.id),
      title: context.chat.title ?? 'Telegram group',
      newStatus: context.myChatMember.new_chat_member.status,
    });
  });
  bot.command('start', async (context) => {
    if (context.from === undefined)
      throw new Error('Message sender is required');
    const token = context.match ?? '';
    if (token.length === 0) {
      await context.reply(renderStartError('BARE_START').text);
      return;
    }

    let handled: boolean;
    try {
      handled = await handlers.handleStart({
        telegramUserId: toTelegramId(context.from.id),
        privateChatId: toTelegramId(context.chat.id),
        token,
      });
    } catch (error) {
      const reason = startErrorReason(error);
      if (reason === undefined) throw error;
      logger.warn('Telegram onboarding input rejected', {
        errorCategory: onboardingErrorCategory(reason),
      });
      await context.reply(renderStartError(reason).text);
      return;
    }
    if (!handled) {
      if (guestHandlers === undefined)
        throw new Error('Unsupported start token');
      await guestHandlers.handleStart({
        telegramUserId: toTelegramId(context.from.id),
        token,
      });
      await context.reply('guest:name');
    }
  });
  if (guestHandlers !== undefined) {
    bot.on('message:text', async (context) => {
      if (context.from === undefined || context.message.text.startsWith('/'))
        return;
      const handled = await guestHandlers.handleName({
        telegramUserId: toTelegramId(context.from.id),
        text: context.message.text,
        updateId: context.update.update_id,
      });
      if (handled) await context.reply('guest:registered');
    });
  }
  bot.callbackQuery(/^cfg:/, async (context) => {
    try {
      const result = await handlers.handleCallback({
        telegramUserId: toTelegramId(context.callbackQuery.from.id),
        privateChatId: toTelegramId(
          context.callbackQuery.message?.chat.id ??
            context.callbackQuery.from.id,
        ),
        messageId:
          context.callbackQuery.message === undefined
            ? undefined
            : BigInt(context.callbackQuery.message.message_id),
        data: context.callbackQuery.data,
      });
      await context.answerCallbackQuery({
        text: result.notice,
        show_alert: result.showAlert,
      });
    } catch (error) {
      const errorCategory = callbackErrorCategory(error);
      if (errorCategory === undefined) {
        await acknowledgeCallbackBestEffort(context);
        throw error;
      }
      logger.warn('Telegram onboarding input rejected', {
        errorCategory: `onboarding.${errorCategory.toLowerCase()}`,
      });
      await context.answerCallbackQuery({
        text: callbackErrorText(errorCategory),
        show_alert: true,
      });
    }
  });

  return bot;
};

const startErrorReason = (error: unknown): StartErrorReason | undefined => {
  if (error instanceof StartTokenVerificationError) {
    return error.reason === 'EXPIRED' ? 'EXPIRED_LINK' : 'INVALID_LINK';
  }
  if (error instanceof AuthorizationDeniedError) return 'ADMIN_REQUIRED';
  if (error instanceof OnboardingInputError) {
    if (error.code === 'INVALID_LINK') return 'INVALID_LINK';
    if (error.code === 'FOREIGN_LINK') return 'FOREIGN_LINK';
    if (error.code === 'ADMIN_REQUIRED') return 'ADMIN_REQUIRED';
  }
  return undefined;
};

const onboardingErrorCategory = (reason: StartErrorReason): string =>
  `onboarding.${reason.toLowerCase()}`;

type CallbackErrorCategory =
  'INVALID_CALLBACK' | 'INVALID_LINK' | 'FOREIGN_LINK' | 'ADMIN_REQUIRED';

const callbackErrorCategory = (
  error: unknown,
): CallbackErrorCategory | undefined => {
  if (error instanceof AuthorizationDeniedError) return 'ADMIN_REQUIRED';
  if (error instanceof OnboardingInputError) return error.code;
  return undefined;
};

const callbackErrorText = (category: CallbackErrorCategory): string =>
  ({
    INVALID_CALLBACK: 'Эта кнопка больше не действует.',
    INVALID_LINK: 'Группа для этой настройки не найдена.',
    FOREIGN_LINK: 'Эта кнопка предназначена для другого администратора.',
    ADMIN_REQUIRED: 'Для настройки нужны права администратора группы.',
  })[category];

const acknowledgeCallbackBestEffort = async (
  context: Context,
): Promise<void> => {
  try {
    await context.answerCallbackQuery();
  } catch {
    // Preserve the original operational error if Telegram cannot be reached.
  }
};

export const createLazyTelegramUpdateHandler = (
  bot: Bot<Context>,
): { handleUpdate(update: Update): Promise<void> } => {
  let initialization: Promise<void> | undefined;

  return {
    async handleUpdate(update: Update): Promise<void> {
      if (!bot.isInited()) {
        initialization ??= bot.init().catch((error: unknown) => {
          initialization = undefined;
          throw error;
        });
        await initialization;
      }
      await bot.handleUpdate(update);
    },
  };
};

export class GrammyTelegramGateway implements TelegramGateway {
  constructor(private readonly bot: Bot<Context>) {}

  async getChatMember(
    chatId: TelegramId,
    userId: TelegramId,
  ): Promise<{
    status: Awaited<ReturnType<TelegramGateway['getChatMember']>>['status'];
  }> {
    const member = await this.bot.api.getChatMember(
      Number(chatId),
      Number(userId),
    );
    return { status: member.status };
  }

  async sendMessage(
    chatId: TelegramId,
    message: string,
    options?: {
      parseMode?: 'HTML';
      keyboard?: readonly (readonly {
        text: string;
        callbackData: string;
      }[])[];
    },
  ): Promise<{ messageId: bigint }> {
    const sent = await this.bot.api.sendMessage(Number(chatId), message, {
      parse_mode: options?.parseMode,
      reply_markup:
        options?.keyboard === undefined
          ? undefined
          : {
              inline_keyboard: options.keyboard.map((row) =>
                row.map((button) => ({
                  text: button.text,
                  callback_data: button.callbackData,
                })),
              ),
            },
    });
    return { messageId: BigInt(sent.message_id) };
  }

  async editMessage(
    chatId: TelegramId,
    messageId: bigint,
    message: string,
    options?: {
      parseMode?: 'HTML';
      keyboard?: readonly (readonly {
        text: string;
        callbackData: string;
      }[])[];
    },
  ): Promise<void> {
    try {
      await this.bot.api.editMessageText(
        Number(chatId),
        Number(messageId),
        message,
        {
          parse_mode: options?.parseMode,
          reply_markup:
            options?.keyboard === undefined
              ? undefined
              : {
                  inline_keyboard: options.keyboard.map((row) =>
                    row.map((button) => ({
                      text: button.text,
                      callback_data: button.callbackData,
                    })),
                  ),
                },
        },
      );
    } catch (error) {
      const description =
        error instanceof Error ? error.message : String(error);
      if (/message (?:can't be edited|to edit not found)/i.test(description)) {
        throw new TelegramMessageNotEditableError(description);
      }
      if (/message is not modified/i.test(description)) return;
      throw error;
    }
  }

  async pinMessage(chatId: TelegramId, messageId: bigint): Promise<void> {
    await this.bot.api.pinChatMessage(Number(chatId), Number(messageId));
  }
}
