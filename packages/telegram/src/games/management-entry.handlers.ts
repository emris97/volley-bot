import {
  AuthorizationDeniedError,
  type OrganizerAuthorization,
} from '@volley/application';
import {
  asGameId,
  type GameId,
  type GameState,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import {
  attendanceReplyMarkup,
  type AttendanceHandlers,
} from '../attendance/attendance.handlers.js';
import { CallbackCodec } from '../callbacks/callback-codec.js';
import { toTelegramId } from '../group-onboarding.handlers.js';
import { type PaymentHandlers } from '../payments/payment.handlers.js';

export interface ManagementDirectory {
  resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<{
    groupId: GroupId;
    gameId: GameId;
    userId: UserId;
    gameState: GameState;
    dmAvailable: boolean;
    hasFinalizedAttendance: boolean;
  } | null>;
  markPrivateAvailable?(telegramUserId: TelegramId): Promise<void>;
  markPrivateUnavailable(telegramUserId: TelegramId): Promise<void>;
}

export interface ManagementMenu {
  gameId: GameId;
  text: 'Управление игрой';
  buttons: readonly {
    text: string;
    action: 'attendance' | 'payment';
  }[];
}

export class ManagementEntryHandlers {
  public constructor(
    private readonly directory: ManagementDirectory,
    private readonly authorization: OrganizerAuthorization,
  ) {}

  public async open(input: {
    gameId: GameId;
    telegramUserId: TelegramId;
    privateChat: boolean;
  }): Promise<ManagementMenu | null> {
    const context = await this.directory.resolve(
      input.gameId,
      input.telegramUserId,
    );
    if (context === null) return null;
    try {
      await this.authorization.requireOrganizer(
        context.groupId,
        context.userId,
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) return null;
      throw error;
    }
    if (!input.privateChat && !context.dmAvailable) return null;
    const buttons: ManagementMenu['buttons'] =
      context.gameState === 'COMPLETED'
        ? [
            { text: 'Посещаемость', action: 'attendance' },
            ...(context.hasFinalizedAttendance
              ? ([{ text: 'Расчёт оплат', action: 'payment' }] as const)
              : []),
          ]
        : [];
    return { gameId: context.gameId, text: 'Управление игрой', buttons };
  }

  public async authorizeAction(input: {
    gameId: GameId;
    telegramUserId: TelegramId;
    action: 'attendance' | 'payment';
  }): Promise<boolean> {
    const menu = await this.open({ ...input, privateChat: true });
    return (
      menu?.buttons.some((button) => button.action === input.action) ?? false
    );
  }

  public markPrivateUnavailable(telegramUserId: TelegramId): Promise<void> {
    return this.directory.markPrivateUnavailable(telegramUserId);
  }
}

export const registerPrivateChatLinking = (
  bot: Bot<Context>,
  directory: Pick<ManagementDirectory, 'markPrivateAvailable'>,
): Bot<Context> => {
  bot.use(async (context, next) => {
    if (context.chat?.type === 'private' && context.from !== undefined) {
      await directory.markPrivateAvailable?.(toTelegramId(context.from.id));
    }
    await next();
  });
  return bot;
};

export const registerManagementEntryHandlers = (
  bot: Bot<Context>,
  handlers: ManagementEntryHandlers,
  attendance: AttendanceHandlers,
  payments: PaymentHandlers,
): Bot<Context> => {
  const codec = new CallbackCodec();
  bot.command('manage', async (context) => {
    if (context.from === undefined || context.chat.type !== 'private') return;
    const menu = await handlers.open({
      gameId: parseGameId(context.match ?? ''),
      telegramUserId: toTelegramId(context.from.id),
      privateChat: true,
    });
    await context.reply(
      menu?.text ?? 'management:unavailable',
      menu === null ? undefined : menuMarkup(menu),
    );
  });
  bot.callbackQuery(/^v1:manage:/, async (context) => {
    const decoded = codec.decode(context.callbackQuery.data);
    const telegramUserId = toTelegramId(context.callbackQuery.from.id);
    const privateChat = context.callbackQuery.message?.chat.type === 'private';
    const menu = await handlers.open({
      gameId: decoded.gameId,
      telegramUserId,
      privateChat,
    });
    if (menu !== null) {
      if (privateChat) {
        await context.editMessageText(menu.text, menuMarkup(menu));
      } else {
        try {
          await context.api.sendMessage(
            Number(telegramUserId),
            menu.text,
            menuMarkup(menu),
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (/forbidden|chat not found|bot was blocked/i.test(message)) {
            await handlers.markPrivateUnavailable(telegramUserId);
          } else {
            throw error;
          }
        }
      }
    }
    await context.answerCallbackQuery({
      text: 'management:check-private-chat',
    });
  });
  bot.callbackQuery(/^mg:/, async (context) => {
    const action = parseManagementAction(context.callbackQuery.data);
    const telegramUserId = toTelegramId(context.callbackQuery.from.id);
    if (
      context.callbackQuery.message?.chat.type !== 'private' ||
      !(await handlers.authorizeAction({
        gameId: action.gameId,
        telegramUserId,
        action: action.action,
      }))
    ) {
      await context.answerCallbackQuery({ text: 'management:unavailable' });
      return;
    }
    if (action.action === 'attendance') {
      const preview = await attendance.start({
        telegramUserId,
        gameId: action.gameId,
      });
      await context.editMessageText(
        preview.text,
        attendanceReplyMarkup(preview),
      );
    } else {
      const view = await payments.start({
        telegramUserId,
        gameId: action.gameId,
        privateChat: true,
      });
      await context.editMessageText(view.text);
    }
    await context.answerCallbackQuery({ text: 'management:opened' });
  });
  return bot;
};

const menuMarkup = (menu: ManagementMenu) => ({
  reply_markup: {
    inline_keyboard: menu.buttons.map((button) => [
      {
        text: button.text,
        callback_data: managementAction(button.action, menu.gameId),
      },
    ]),
  },
});

const managementAction = (
  action: 'attendance' | 'payment',
  gameId: GameId,
): string => `mg:${action === 'attendance' ? 'a' : 'p'}:${compactUuid(gameId)}`;

const parseManagementAction = (
  value: string,
): { action: 'attendance' | 'payment'; gameId: GameId } => {
  const [prefix, code, compactGameId, ...rest] = value.split(':');
  if (
    prefix !== 'mg' ||
    (code !== 'a' && code !== 'p') ||
    compactGameId === undefined ||
    rest.length > 0
  ) {
    throw new Error('Invalid management callback');
  }
  return {
    action: code === 'a' ? 'attendance' : 'payment',
    gameId: asGameId(decodeCompactUuid(compactGameId)),
  };
};

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');

const decodeCompactUuid = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error('Invalid management callback');
  }
  const hex = Buffer.from(value, 'base64url').toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const parseGameId = (value: string): GameId => {
  const gameId = value.trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(gameId)) {
    throw new Error('Valid game id required');
  }
  return asGameId(gameId);
};
