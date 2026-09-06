import {
  AuthorizationDeniedError,
  GameEditNotAllowedError,
  GameRevisionConflictError,
  type ChangeGameStateCommand,
  type DeleteDraftGameCommand,
  type GamePage,
  type ListGamesCommand,
  type OrganizerAuthorization,
  type TelegramGateway,
} from '@volley/application';
import {
  asGameId,
  type Game,
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
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import { type PaymentHandlers } from '../payments/payment.handlers.js';
import {
  parseGameActionCallback,
  renderGameActionConfirmation,
  renderGameList,
  renderGameManagement,
  type ConfirmableGameAction,
  type ManagementGameView,
} from './game-list.presenter.js';

export interface ManagementContextRecord extends ManagementGameView {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  telegramChatId: TelegramId;
  gameState: GameState;
  dmAvailable: boolean;
}

export interface ManagementDirectory {
  resolveGameGroup?(gameId: GameId): Promise<{
    groupId: GroupId;
    telegramChatId: TelegramId;
  } | null>;
  refreshMembership?(input: {
    groupId: GroupId;
    telegramUserId: TelegramId;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    status: 'ACTIVE' | 'LEFT';
  }): Promise<UserId>;
  resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<ManagementContextRecord | null>;
  markPrivateAvailable?(telegramUserId: TelegramId): Promise<void>;
  markPrivateUnavailable(telegramUserId: TelegramId): Promise<void>;
}

export interface ManagementActions {
  changeState(command: ChangeGameStateCommand): Promise<Game>;
  deleteDraft(command: DeleteDraftGameCommand): Promise<void>;
  listGames?(command: ListGamesCommand): Promise<GamePage>;
}

export type ManagementMenu = OrganizerView;

export type ManagementActionResult =
  | { kind: 'VIEW'; view: OrganizerView }
  | { kind: 'ATTENDANCE'; gameId: GameId }
  | { kind: 'PAYMENT'; gameId: GameId };

export class ManagementAccessDeniedError extends Error {
  public constructor(
    message = 'Управление доступно только администраторам группы.',
  ) {
    super(message);
    this.name = 'ManagementAccessDeniedError';
  }
}

export class ManagementEntryHandlers {
  public constructor(
    private readonly directory: ManagementDirectory,
    private readonly authorization: OrganizerAuthorization,
    private readonly telegram?: Pick<TelegramGateway, 'getChatMember'>,
    private readonly actions?: ManagementActions,
  ) {}

  public async open(input: {
    gameId: GameId;
    telegramUserId: TelegramId;
    privateChat: boolean;
  }): Promise<ManagementMenu | null> {
    const context = await this.resolveAuthorized(
      input.gameId,
      input.telegramUserId,
    );
    if (!input.privateChat && !context.dmAvailable) return null;
    return renderGameManagement(context);
  }

  public async handleAction(input: {
    data: string;
    telegramUserId: TelegramId;
    privateChat: boolean;
  }): Promise<ManagementActionResult> {
    if (!input.privateChat) throw new ManagementAccessDeniedError();
    const callback = parseGameActionCallback(input.data);
    const context = await this.resolveAuthorized(
      callback.gameId,
      input.telegramUserId,
    );

    if (callback.action === 'view') {
      return { kind: 'VIEW', view: renderGameManagement(context) };
    }
    if (callback.action === 'attendance' || callback.action === 'payment') {
      if (context.game.state !== 'COMPLETED') {
        return unavailableAction(context);
      }
      if (callback.action === 'payment' && !context.hasFinalizedAttendance) {
        return {
          kind: 'VIEW',
          view: renderGameManagement(
            context,
            'Сначала завершите учёт посещаемости.',
          ),
        };
      }
      return {
        kind: callback.action === 'attendance' ? 'ATTENDANCE' : 'PAYMENT',
        gameId: context.gameId,
      };
    }
    if (callback.action === 'summary') {
      return context.game.state === 'COMPLETED'
        ? {
            kind: 'VIEW',
            view: renderGameManagement(context, 'Итоги игры показаны выше.'),
          }
        : unavailableAction(context);
    }
    if (callback.action === 'next-u' || callback.action === 'next-h') {
      if (this.actions?.listGames === undefined) {
        return unavailableAction(context);
      }
      const bucket = callback.action === 'next-u' ? 'UPCOMING' : 'HISTORY';
      const page = await this.actions.listGames({
        groupId: context.groupId,
        actorUserId: context.userId,
        bucket,
        limit: 8,
        cursor: callback.gameId,
      });
      return {
        kind: 'VIEW',
        view: renderGameList({
          bucket,
          items: page.items,
          nextCursor: page.nextCursor,
          timeZone: context.game.timeZone,
        }),
      };
    }
    if (callback.action === 'edit') {
      return callback.revision === context.game.revision &&
        editableStates.has(context.game.state)
        ? {
            kind: 'VIEW',
            view: renderGameManagement(
              context,
              'Выберите поле игры для изменения.',
            ),
          }
        : staleOrUnavailable(context, callback.revision);
    }

    const parsed = parseConfirmableAction(callback.action);
    if (parsed === null) return unavailableAction(context);
    const target = targetState(parsed.action, context.game);
    if (parsed.confirmed && target !== null && context.game.state === target) {
      return {
        kind: 'VIEW',
        view: renderGameManagement(context, 'Действие уже выполнено.'),
      };
    }
    if (callback.revision !== context.game.revision) {
      return staleAction(context);
    }
    if (!validAction(context.game.state, parsed.action)) {
      return unavailableAction(context);
    }
    if (!parsed.confirmed) {
      return {
        kind: 'VIEW',
        view: renderGameActionConfirmation(context, parsed.action),
      };
    }

    if (parsed.action === 'delete') {
      if (this.actions === undefined) return unavailableAction(context);
      try {
        await this.actions.deleteDraft({
          groupId: context.groupId,
          gameId: context.gameId,
          actorUserId: context.userId,
          expectedRevision: callback.revision,
        });
        return { kind: 'VIEW', view: deletedDraftView() };
      } catch (error) {
        const message = managementErrorMessage(error);
        if (message === null) throw error;
        return {
          kind: 'VIEW',
          view: renderGameManagement(context, message),
        };
      }
    }

    if (target === null || this.actions === undefined) {
      return unavailableAction(context);
    }
    try {
      const game = await this.actions.changeState({
        groupId: context.groupId,
        gameId: context.gameId,
        actorUserId: context.userId,
        expectedRevision: callback.revision,
        targetState: target,
      });
      return {
        kind: 'VIEW',
        view: renderGameManagement(
          { ...context, game },
          successText(parsed.action),
        ),
      };
    } catch (error) {
      const message = managementErrorMessage(error);
      if (message === null) throw error;
      return {
        kind: 'VIEW',
        view: renderGameManagement(context, message),
      };
    }
  }

  public async authorizeAction(input: {
    gameId: GameId;
    telegramUserId: TelegramId;
    action: 'attendance' | 'payment';
  }): Promise<boolean> {
    try {
      const context = await this.resolveAuthorized(
        input.gameId,
        input.telegramUserId,
      );
      return (
        context.game.state === 'COMPLETED' &&
        (input.action === 'attendance' || context.hasFinalizedAttendance)
      );
    } catch (error) {
      if (managementErrorMessage(error) !== null) return false;
      throw error;
    }
  }

  public markPrivateUnavailable(telegramUserId: TelegramId): Promise<void> {
    return this.directory.markPrivateUnavailable(telegramUserId);
  }

  private async resolveAuthorized(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<ManagementContextRecord> {
    if (
      this.telegram !== undefined &&
      this.directory.resolveGameGroup !== undefined &&
      this.directory.refreshMembership !== undefined
    ) {
      const location = await this.directory.resolveGameGroup(gameId);
      if (location === null) throw new Error('Игра не найдена.');
      const member = await this.telegram.getChatMember(
        location.telegramChatId,
        telegramUserId,
      );
      const role =
        member.status === 'creator'
          ? 'OWNER'
          : member.status === 'administrator'
            ? 'ADMIN'
            : null;
      await this.directory.refreshMembership({
        groupId: location.groupId,
        telegramUserId,
        role: role ?? 'MEMBER',
        status: role === null ? 'LEFT' : 'ACTIVE',
      });
      if (role === null) throw new ManagementAccessDeniedError();
    }

    const context = await this.directory.resolve(gameId, telegramUserId);
    if (context === null) throw new Error('Игра не найдена.');
    try {
      await this.authorization.requireOrganizer(
        context.groupId,
        context.userId,
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        throw new ManagementAccessDeniedError();
      }
      throw error;
    }
    return context;
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
    try {
      const menu = await handlers.open({
        gameId: parseGameId(context.match ?? ''),
        telegramUserId: toTelegramId(context.from.id),
        privateChat: true,
      });
      await context.reply(
        menu?.text ?? 'Игра недоступна для управления.',
        menu === null ? undefined : viewOptions(menu),
      );
    } catch (error) {
      const message = managementErrorMessage(error);
      if (message === null) throw error;
      await context.reply(message);
    }
  });
  bot.callbackQuery(/^v1:manage:/, async (context) => {
    const telegramUserId = toTelegramId(context.callbackQuery.from.id);
    const privateChat = context.callbackQuery.message?.chat.type === 'private';
    try {
      const decoded = codec.decode(context.callbackQuery.data);
      const menu = await handlers.open({
        gameId: decoded.gameId,
        telegramUserId,
        privateChat,
      });
      if (menu === null) {
        await context.answerCallbackQuery({
          text: 'Откройте личный чат с ботом и нажмите Start.',
        });
        return;
      }
      if (privateChat) {
        await context.editMessageText(menu.text, viewOptions(menu));
      } else {
        try {
          await context.api.sendMessage(
            Number(telegramUserId),
            menu.text,
            viewOptions(menu),
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
      await context.answerCallbackQuery({ text: 'Проверьте личный чат.' });
    } catch (error) {
      const message = managementErrorMessage(error);
      if (message === null) throw error;
      await context.answerCallbackQuery({ text: message });
    }
  });
  bot.callbackQuery(/^ga:/, async (context) => {
    if (context.callbackQuery.message?.chat.type !== 'private') {
      await context.answerCallbackQuery({
        text: 'Управление доступно только в личном чате.',
      });
      return;
    }
    try {
      const result = await handlers.handleAction({
        data: context.callbackQuery.data,
        telegramUserId: toTelegramId(context.callbackQuery.from.id),
        privateChat: true,
      });
      if (result.kind === 'VIEW') {
        await context.editMessageText(
          result.view.text,
          viewOptions(result.view),
        );
      } else if (result.kind === 'ATTENDANCE') {
        const preview = await attendance.start({
          telegramUserId: toTelegramId(context.callbackQuery.from.id),
          gameId: result.gameId,
        });
        await context.editMessageText(
          preview.text,
          attendanceReplyMarkup(preview),
        );
      } else {
        const view = await payments.start({
          telegramUserId: toTelegramId(context.callbackQuery.from.id),
          gameId: result.gameId,
          privateChat: true,
        });
        await context.editMessageText(view.text);
      }
      await context.answerCallbackQuery({ text: 'Готово.' });
    } catch (error) {
      const message = managementErrorMessage(error);
      if (message === null) throw error;
      await context.answerCallbackQuery({ text: message });
    }
  });
  bot.callbackQuery(/^mg:/, async (context) => {
    try {
      const action = parseLegacyManagementAction(context.callbackQuery.data);
      const telegramUserId = toTelegramId(context.callbackQuery.from.id);
      if (
        context.callbackQuery.message?.chat.type !== 'private' ||
        !(await handlers.authorizeAction({
          gameId: action.gameId,
          telegramUserId,
          action: action.action,
        }))
      ) {
        await context.answerCallbackQuery({
          text: 'Управление недоступно.',
        });
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
      await context.answerCallbackQuery({ text: 'Открыто.' });
    } catch (error) {
      const message = managementErrorMessage(error);
      if (message === null) throw error;
      await context.answerCallbackQuery({ text: message });
    }
  });
  return bot;
};

const viewOptions = (view: OrganizerView) => ({
  parse_mode: view.parseMode,
  reply_markup: {
    inline_keyboard: view.keyboard.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      })),
    ),
  },
});

const confirmableActions = new Set<ConfirmableGameAction>([
  'publish',
  'delete',
  'open',
  'close',
  'reopen',
  'complete',
  'cancel',
]);

const parseConfirmableAction = (
  action: string,
): { action: ConfirmableGameAction; confirmed: boolean } | null => {
  const confirmed = action.endsWith('-confirm');
  const base = confirmed ? action.slice(0, -'-confirm'.length) : action;
  return confirmableActions.has(base as ConfirmableGameAction)
    ? { action: base as ConfirmableGameAction, confirmed }
    : null;
};

const validAction = (
  state: GameState,
  action: ConfirmableGameAction,
): boolean => {
  const actions: Record<GameState, readonly ConfirmableGameAction[]> = {
    DRAFT: ['publish', 'delete'],
    SCHEDULED: ['open', 'cancel'],
    OPEN: ['close', 'cancel'],
    CLOSED: ['reopen', 'complete', 'cancel'],
    COMPLETED: [],
    CANCELLED: [],
  };
  return actions[state].includes(action);
};

const targetState = (
  action: ConfirmableGameAction,
  game: Game,
): GameState | null => {
  if (action === 'delete') return null;
  if (action === 'publish') {
    return game.registrationOpensAt.getTime() <= Date.now()
      ? 'OPEN'
      : 'SCHEDULED';
  }
  switch (action) {
    case 'open':
    case 'reopen':
      return 'OPEN';
    case 'close':
      return 'CLOSED';
    case 'complete':
      return 'COMPLETED';
    case 'cancel':
      return 'CANCELLED';
  }
};

const successText = (action: ConfirmableGameAction): string =>
  ({
    publish: 'Игра опубликована.',
    delete: 'Черновик игры удалён.',
    open: 'Регистрация открыта.',
    close: 'Регистрация закрыта.',
    reopen: 'Регистрация снова открыта.',
    complete: 'Игра завершена.',
    cancel: 'Игра отменена.',
  })[action];

const staleAction = (
  context: ManagementContextRecord,
): ManagementActionResult => ({
  kind: 'VIEW',
  view: renderGameManagement(
    context,
    'Игра уже была изменена. Откройте актуальную версию.',
  ),
});

const unavailableAction = (
  context: ManagementContextRecord,
): ManagementActionResult => ({
  kind: 'VIEW',
  view: renderGameManagement(
    context,
    'Действие недоступно в текущем состоянии игры.',
  ),
});

const staleOrUnavailable = (
  context: ManagementContextRecord,
  revision: number,
): ManagementActionResult =>
  revision === context.game.revision
    ? unavailableAction(context)
    : staleAction(context);

const deletedDraftView = (): OrganizerView => ({
  text: 'Черновик игры удалён.',
  parseMode: 'HTML',
  keyboard: [[{ text: 'К играм', callbackData: 'om:v1:games:upcoming' }]],
});

const editableStates = new Set<GameState>([
  'DRAFT',
  'SCHEDULED',
  'OPEN',
  'CLOSED',
]);

const managementErrorMessage = (error: unknown): string | null => {
  if (
    error instanceof ManagementAccessDeniedError ||
    error instanceof AuthorizationDeniedError
  ) {
    return 'Управление доступно только администраторам группы.';
  }
  if (
    error instanceof GameRevisionConflictError ||
    error instanceof GameEditNotAllowedError
  ) {
    return error.message;
  }
  if (!(error instanceof Error)) return null;
  if (/^Game not found$/i.test(error.message)) return 'Игра не найдена.';
  if (/invalid game transition/i.test(error.message)) {
    return 'Действие недоступно в текущем состоянии игры.';
  }
  if (
    /^(?:Unsupported callback version|Invalid game callback|Invalid management callback)$/i.test(
      error.message,
    )
  ) {
    return 'Некорректная кнопка управления игрой.';
  }
  return /^(?:Игра|Некорректная|Действие|Это поле|Можно удалить|Введите)/.test(
    error.message,
  )
    ? error.message
    : null;
};

const parseLegacyManagementAction = (
  value: string,
): { action: 'attendance' | 'payment'; gameId: GameId } => {
  const [prefix, code, compactGameId, ...rest] = value.split(':');
  if (
    prefix !== 'mg' ||
    (code !== 'a' && code !== 'p') ||
    compactGameId === undefined ||
    rest.length > 0
  ) {
    throw new Error('Некорректная кнопка управления игрой.');
  }
  return {
    action: code === 'a' ? 'attendance' : 'payment',
    gameId: asGameId(decodeCompactUuid(compactGameId)),
  };
};

const decodeCompactUuid = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error('Некорректная кнопка управления игрой.');
  }
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) {
    throw new Error('Некорректная кнопка управления игрой.');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const parseGameId = (value: string): GameId => {
  const gameId = value.trim();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(gameId)) {
    throw new Error('Введите корректный идентификатор игры.');
  }
  return asGameId(gameId);
};
