import type { TelegramGateway } from '@volley/application';
import type { TelegramId } from '@volley/domain';
import { Bot, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import {
  GroupOnboardingHandlers,
  toTelegramId,
} from './group-onboarding.handlers.js';
import type { GuestFlowHandlers } from './registrations/guest-flow.handlers.js';
import { TelegramMessageNotEditableError } from './messages/game-message-updater.js';

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
    const handled = await handlers.handleStart({
      telegramUserId: toTelegramId(context.from.id),
      privateChatId: toTelegramId(context.chat.id),
      token: context.match ?? '',
    });
    if (!handled) {
      if (guestHandlers === undefined)
        throw new Error('Unsupported start token');
      await guestHandlers.handleStart({
        telegramUserId: toTelegramId(context.from.id),
        token: context.match ?? '',
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
    const chatId = context.callbackQuery.message?.chat.id;
    if (chatId === undefined) throw new Error('Callback message is required');
    await handlers.handleCallback({
      telegramUserId: toTelegramId(context.callbackQuery.from.id),
      privateChatId: toTelegramId(chatId),
      data: context.callbackQuery.data,
    });
  });

  return bot;
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
      throw error;
    }
  }

  async pinMessage(chatId: TelegramId, messageId: bigint): Promise<void> {
    await this.bot.api.pinChatMessage(Number(chatId), Number(messageId));
  }
}
