import type { TelegramGateway } from '@volley/application';
import type { TelegramId } from '@volley/domain';
import { Bot, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import {
  GroupOnboardingHandlers,
  toTelegramId,
} from './group-onboarding.handlers.js';

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
    await handlers.handleStart({
      telegramUserId: toTelegramId(context.from.id),
      privateChatId: toTelegramId(context.chat.id),
      token: context.match ?? '',
    });
  });
  bot.on('callback_query:data', async (context) => {
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

  async sendMessage(chatId: TelegramId, message: string): Promise<void> {
    await this.bot.api.sendMessage(Number(chatId), message);
  }
}
