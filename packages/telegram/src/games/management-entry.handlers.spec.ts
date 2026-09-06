import {
  AuthorizationDeniedError,
  GameRevisionConflictError,
  type GameEditSession,
} from '@volley/application';
import {
  asGameId,
  asGroupId,
  asTelegramId,
  asUserId,
  type Game,
} from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
} from '../bot.factory.js';
import { compactGameUuid } from './game-creation.model.js';
import {
  gameActionCallback,
  gameEditFieldAction,
} from './game-list.presenter.js';
import {
  ManagementAccessDeniedError,
  type ManagementActions,
  ManagementEntryHandlers,
  type ManagementSummary,
  registerManagementEntryHandlers,
} from './management-entry.handlers.js';

const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const userId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424612');
const telegramUserId = asTelegramId('42');

describe('ManagementEntryHandlers', () => {
  it('performs a fresh live Telegram check and renders the complete state menu', async () => {
    const harness = handlersFor({ game: managedGame({ state: 'COMPLETED' }) });

    const menu = await harness.handlers.open({
      gameId,
      telegramUserId,
      privateChat: true,
    });

    expect(harness.telegram.getChatMember).toHaveBeenCalledWith(
      asTelegramId('-1001'),
      telegramUserId,
    );
    expect(harness.directory.refreshMembership).toHaveBeenCalledWith({
      groupId,
      telegramUserId,
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(menu?.keyboard.flat().map(({ text }) => text)).toEqual([
      'Посещаемость',
      'Расчёт оплат',
      'Итоги',
      'К списку',
    ]);
  });

  it('keeps settlement visible but gates the existing payment flow until attendance is finalized', async () => {
    const harness = handlersFor({
      game: managedGame({ state: 'COMPLETED' }),
      hasFinalizedAttendance: false,
    });

    const result = await harness.handlers.handleAction({
      data: gameActionCallback('payment', gameId, 4),
      telegramUserId,
      privateChat: true,
    });

    expect(result).toMatchObject({
      kind: 'VIEW',
      view: {
        text: expect.stringContaining('Сначала завершите учёт посещаемости.'),
      },
    });
    await expect(
      harness.handlers.authorizeAction({
        gameId,
        telegramUserId,
        action: 'payment',
      }),
    ).resolves.toBe(false);
  });

  it('bootstraps a previously unknown live administrator from game to group', async () => {
    const harness = handlersFor({
      game: managedGame({ state: 'SCHEDULED' }),
    });

    await expect(
      harness.handlers.open({ gameId, telegramUserId, privateChat: true }),
    ).resolves.toMatchObject({
      text: expect.stringContaining('Вечерняя игра'),
    });
    expect(harness.directory.resolveGameGroup).toHaveBeenCalledWith(gameId);
    expect(harness.directory.refreshMembership).toHaveBeenCalledOnce();
    expect(harness.directory.resolve).toHaveBeenCalledWith(
      gameId,
      telegramUserId,
    );
  });

  it('rejects a live non-administrator with the exact Russian response', async () => {
    const harness = handlersFor({ telegramStatus: 'member' });

    await expect(
      harness.handlers.open({ gameId, telegramUserId, privateChat: false }),
    ).rejects.toEqual(
      new ManagementAccessDeniedError(
        'Управление доступно только администраторам группы.',
      ),
    );
    expect(harness.directory.refreshMembership).toHaveBeenCalledWith({
      groupId,
      telegramUserId,
      role: 'MEMBER',
      status: 'LEFT',
    });
  });

  it('does not expose a group card through public callback when private chat is unavailable', async () => {
    const harness = handlersFor({ dmAvailable: false });

    await expect(
      harness.handlers.open({ gameId, telegramUserId, privateChat: false }),
    ).resolves.toBeNull();
  });

  it('separates state confirmation from mutation and passes the callback revision', async () => {
    const changeState = vi
      .fn()
      .mockResolvedValue(managedGame({ state: 'CLOSED', revision: 5 }));
    const harness = handlersFor({
      game: managedGame({ state: 'OPEN', revision: 4 }),
      actions: { changeState },
    });

    const confirmation = await harness.handlers.handleAction({
      data: gameActionCallback('close', gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    expect(confirmation).toMatchObject({
      kind: 'VIEW',
      view: { text: expect.stringContaining('Закрыть регистрацию?') },
    });
    expect(changeState).not.toHaveBeenCalled();

    const result = await harness.handlers.handleAction({
      data: gameActionCallback('close-confirm', gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    expect(changeState).toHaveBeenCalledWith({
      groupId,
      gameId,
      actorUserId: userId,
      expectedRevision: 4,
      targetState: 'CLOSED',
    });
    expect(result).toMatchObject({
      kind: 'VIEW',
      view: { text: expect.stringContaining('регистрация закрыта') },
    });
    expect(harness.telegram.getChatMember).toHaveBeenCalledTimes(2);
  });

  it('rejects stale and state-invalid controls without mutating', async () => {
    const changeState = vi.fn();
    const harness = handlersFor({
      game: managedGame({ state: 'OPEN', revision: 4 }),
      actions: { changeState },
    });

    const stale = await harness.handlers.handleAction({
      data: gameActionCallback('close-confirm', gameId, 3),
      telegramUserId,
      privateChat: true,
    });
    const invalid = await harness.handlers.handleAction({
      data: gameActionCallback('complete', gameId, 4),
      telegramUserId,
      privateChat: true,
    });

    expect(stale).toMatchObject({
      view: {
        text: expect.stringContaining(
          'Игра уже была изменена. Откройте актуальную версию.',
        ),
      },
    });
    expect(invalid).toMatchObject({
      view: { text: expect.stringContaining('Действие недоступно') },
    });
    expect(changeState).not.toHaveBeenCalled();
  });

  it('treats a replay that already reached the target as idempotent', async () => {
    const changeState = vi.fn();
    const harness = handlersFor({
      game: managedGame({ state: 'CLOSED', revision: 5 }),
      actions: { changeState },
    });

    const replay = await harness.handlers.handleAction({
      data: gameActionCallback('close-confirm', gameId, 4),
      telegramUserId,
      privateChat: true,
    });

    expect(replay).toMatchObject({
      kind: 'VIEW',
      view: { text: expect.stringContaining('регистрация закрыта') },
    });
    expect(changeState).not.toHaveBeenCalled();
  });

  it('deletes only after the draft confirmation callback', async () => {
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const harness = handlersFor({
      game: managedGame({ state: 'DRAFT', revision: 2 }),
      actions: { deleteDraft },
    });

    await harness.handlers.handleAction({
      data: gameActionCallback('delete', gameId, 2),
      telegramUserId,
      privateChat: true,
    });
    expect(deleteDraft).not.toHaveBeenCalled();
    const result = await harness.handlers.handleAction({
      data: gameActionCallback('delete-confirm', gameId, 2),
      telegramUserId,
      privateChat: true,
    });

    expect(deleteDraft).toHaveBeenCalledWith({
      groupId,
      gameId,
      actorUserId: userId,
      expectedRevision: 2,
    });
    expect(result).toMatchObject({
      kind: 'VIEW',
      view: { text: 'Черновик игры удалён.' },
    });
  });

  it('paginates a list from its opaque cursor after live authorization', async () => {
    const listGames = vi.fn().mockResolvedValue({
      items: [
        managedGame({
          id: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424699'),
          state: 'COMPLETED',
          name: 'Предыдущая игра',
        }),
      ],
      nextCursor: null,
    });
    const harness = handlersFor({
      game: managedGame({ state: 'COMPLETED' }),
      actions: { listGames },
    });

    const result = await harness.handlers.handleAction({
      data: gameActionCallback('next-h', gameId, 4),
      telegramUserId,
      privateChat: true,
    });

    expect(listGames).toHaveBeenCalledWith({
      groupId,
      actorUserId: userId,
      bucket: 'HISTORY',
      limit: 8,
      cursor: gameId,
    });
    expect(result).toMatchObject({
      kind: 'VIEW',
      view: { text: expect.stringContaining('Прошедшие игры') },
    });
    expect(harness.telegram.getChatMember).toHaveBeenCalledOnce();
  });

  it('persists field input and calls UpdateGame only from its revisioned confirmation', async () => {
    const update = vi.fn().mockResolvedValue({
      game: managedGame({
        state: 'SCHEDULED',
        revision: 5,
        venue: 'Новая арена',
      }),
      rosterCount: 2,
      waitlistCount: 1,
      materialFields: ['venue'],
    });
    const harness = handlersFor({
      game: managedGame({ state: 'SCHEDULED', revision: 4 }),
      actions: { update },
    });

    const editor = await harness.handlers.handleAction({
      data: gameActionCallback(gameEditFieldAction('venue'), gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    expect(editor).toMatchObject({
      view: { text: expect.stringContaining('Отправьте название площадки') },
    });

    const confirmation = await harness.handlers.handleText(
      telegramUserId,
      '  Новая арена  ',
    );
    expect(confirmation).toMatchObject({
      text: expect.stringContaining('Стало: Новая арена'),
    });
    expect(update).not.toHaveBeenCalled();

    const result = await harness.handlers.handleAction({
      data: gameActionCallback('edit-confirm-1', gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    expect(update).toHaveBeenCalledWith({
      groupId,
      gameId,
      actorUserId: userId,
      expectedRevision: 4,
      changes: { venue: 'Новая арена' },
    });
    expect(result).toMatchObject({
      view: { text: expect.stringContaining('Игра изменена.') },
    });

    const replay = await harness.handlers.handleAction({
      data: gameActionCallback('edit-confirm-1', gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    expect(replay).toMatchObject({
      view: { text: expect.stringContaining('Эта форма изменения устарела.') },
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it('rejects stale field and interaction controls without updating the game', async () => {
    const update = vi.fn();
    const harness = handlersFor({ actions: { update } });

    const staleField = await harness.handlers.handleAction({
      data: gameActionCallback(gameEditFieldAction('venue'), gameId, 3),
      telegramUserId,
      privateChat: true,
    });
    expect(staleField).toMatchObject({
      view: {
        text: expect.stringContaining(
          'Игра уже была изменена. Откройте актуальную версию.',
        ),
      },
    });
    expect(harness.directory.startEditSession).not.toHaveBeenCalled();

    await harness.handlers.handleAction({
      data: gameActionCallback(gameEditFieldAction('venue'), gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    await harness.handlers.handleText(telegramUserId, 'Новая арена');
    const replay = await harness.handlers.handleAction({
      data: gameActionCallback('edit-confirm-0', gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    expect(replay).toMatchObject({
      view: { text: expect.stringContaining('Эта форма изменения устарела.') },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('renders a revision conflict during edit in Russian and never retries the update', async () => {
    const update = vi.fn().mockRejectedValue(new GameRevisionConflictError());
    const harness = handlersFor({ actions: { update } });
    await harness.handlers.handleAction({
      data: gameActionCallback(gameEditFieldAction('capacity'), gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    await harness.handlers.handleText(telegramUserId, '16');

    const result = await harness.handlers.handleAction({
      data: gameActionCallback('edit-confirm-1', gameId, 4),
      telegramUserId,
      privateChat: true,
    });

    expect(result).toMatchObject({
      view: {
        text: expect.stringContaining(
          'Игра уже была изменена. Откройте актуальную версию.',
        ),
      },
    });
    expect(update).toHaveBeenCalledOnce();
    expect(harness.directory.clearEditSession).toHaveBeenCalledOnce();
  });

  it('renders UpdateGame validation errors instead of escaping as webhook failures', async () => {
    const update = vi
      .fn()
      .mockRejectedValue(new Error('Время начала игры должно быть в будущем.'));
    const harness = handlersFor({ actions: { update } });
    await harness.handlers.handleAction({
      data: gameActionCallback(gameEditFieldAction('startsAt'), gameId, 4),
      telegramUserId,
      privateChat: true,
    });
    await harness.handlers.handleText(telegramUserId, '10.09.2026 19:30');

    await expect(
      harness.handlers.handleAction({
        data: gameActionCallback('edit-confirm-1', gameId, 4),
        telegramUserId,
        privateChat: true,
      }),
    ).resolves.toMatchObject({
      view: {
        text: expect.stringContaining(
          'Время начала игры должно быть в будущем.',
        ),
      },
    });
  });

  it('renders authoritative attendance and settlement summary for a completed game', async () => {
    const harness = handlersFor({
      game: managedGame({ state: 'COMPLETED' }),
      summary: {
        participationCount: 14,
        attendance: { presentCount: 12, billableCount: 11 },
        settlement: {
          totalMinor: 12_000n,
          paidCount: 8,
          paidMinor: 8_000n,
          unpaidCount: 3,
          unpaidMinor: 3_000n,
          waivedCount: 1,
          waivedMinor: 1_000n,
        },
      },
    });

    const result = await harness.handlers.handleAction({
      data: gameActionCallback('summary', gameId, 4),
      telegramUserId,
      privateChat: true,
    });

    expect(harness.directory.loadSummary).toHaveBeenCalledWith(groupId, gameId);
    expect(result).toMatchObject({
      view: { text: expect.stringContaining('Присутствовали: 12') },
    });
    expect(JSON.stringify(result)).not.toContain(gameId);
  });
});

describe('management Telegram adapter', () => {
  it('routes a private field callback, text input, and confirmation to UpdateGame', async () => {
    const update = vi.fn().mockResolvedValue({
      game: managedGame({ revision: 5, venue: 'Новая арена' }),
      rosterCount: 2,
      waitlistCount: 1,
      materialFields: ['venue'],
    });
    const source = handlersFor({ actions: { update } });
    const harness = botHarness(source.handlers);

    await harness.handle(
      callbackUpdate(
        gameActionCallback(gameEditFieldAction('venue'), gameId, 4),
        true,
      ),
    );
    await harness.handle(textUpdate('Новая арена'));
    expect(update).not.toHaveBeenCalled();
    await harness.handle(
      callbackUpdate(gameActionCallback('edit-confirm-1', gameId, 4), true),
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId,
        expectedRevision: 4,
        changes: { venue: 'Новая арена' },
      }),
    );
    expect(JSON.stringify(harness.apiCalls)).toContain('Игра изменена.');
  });

  it('accepts the canonical public manage callback and sends the private card', async () => {
    const harness = botHarness(handlersFor().handlers);

    await expect(
      harness.handle(
        callbackUpdate(gameActionCallback('manage', gameId, 4), false),
      ),
    ).resolves.toBeUndefined();

    expect(harness.apiCalls).toContainEqual(
      expect.objectContaining({
        method: 'sendMessage',
        payload: expect.objectContaining({ chat_id: 42 }),
      }),
    );
  });

  it('renders the exact non-admin answer and never escapes as a webhook error', async () => {
    const harness = botHarness(
      handlersFor({ telegramStatus: 'member' }).handlers,
    );

    await expect(
      harness.handle(callbackUpdate(`v1:manage:${gameId}`, false)),
    ).resolves.toBeUndefined();

    expect(harness.apiCalls).toContainEqual(
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: expect.objectContaining({
          text: 'Управление доступно только администраторам группы.',
        }),
      }),
    );
  });

  it('renders stale/tampered callback errors in Russian without webhook failure', async () => {
    const harness = botHarness(handlersFor().handlers);

    await expect(
      harness.handle(callbackUpdate('ga:v1:close:not-an-id:!', true)),
    ).resolves.toBeUndefined();

    expect(harness.apiCalls).toContainEqual(
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: expect.objectContaining({
          text: 'Некорректная кнопка управления игрой.',
        }),
      }),
    );
  });

  it('rejects a non-canonical compact UUID in legacy management callbacks', async () => {
    const harness = botHarness(handlersFor().handlers);
    const canonical = compactGameUuid(gameId);
    const aliased = `${canonical.slice(0, -1)}${canonical.endsWith('A') ? 'B' : 'R'}`;

    await expect(
      harness.handle(callbackUpdate(`mg:a:${aliased}`, true)),
    ).resolves.toBeUndefined();

    expect(harness.apiCalls).toContainEqual(
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: expect.objectContaining({
          text: 'Некорректная кнопка управления игрой.',
        }),
      }),
    );

    await expect(
      harness.handle(callbackUpdate(`mg:a:${canonical}:extra`, true)),
    ).resolves.toBeUndefined();
    expect(harness.apiCalls).toContainEqual(
      expect.objectContaining({
        method: 'answerCallbackQuery',
        payload: expect.objectContaining({
          text: 'Некорректная кнопка управления игрой.',
        }),
      }),
    );
  });

  it('maps an expected stale mutation failure without returning webhook 500', async () => {
    const harness = botHarness(
      handlersFor({
        actions: {
          changeState: vi
            .fn()
            .mockRejectedValue(new GameRevisionConflictError()),
        },
      }).handlers,
    );

    await expect(
      harness.handle(
        callbackUpdate(gameActionCallback('close-confirm', gameId, 4), true),
      ),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(harness.apiCalls)).toContain(
      'Игра уже была изменена. Откройте актуальную версию.',
    );
  });

  it.each([
    [
      'v1:manage:not-a-game',
      'Некорректная кнопка управления игрой.',
      undefined,
    ],
    [
      gameActionCallback('close-confirm', gameId, 4),
      'Действие недоступно в текущем состоянии игры.',
      new Error('Invalid game transition: OPEN -> COMPLETED'),
    ],
    [
      gameActionCallback('close-confirm', gameId, 4),
      'Игра не найдена.',
      new Error('Game not found'),
    ],
  ])(
    'maps expected callback failure for %s to Russian without webhook failure',
    async (data, expectedMessage, actionError) => {
      const harness = botHarness(
        handlersFor({
          actions:
            actionError === undefined
              ? undefined
              : { changeState: vi.fn().mockRejectedValue(actionError) },
        }).handlers,
      );

      await expect(
        harness.handle(callbackUpdate(data, true)),
      ).resolves.toBeUndefined();
      expect(JSON.stringify(harness.apiCalls)).toContain(expectedMessage);
    },
  );
});

const handlersFor = (
  options: {
    game?: Game;
    dmAvailable?: boolean;
    hasFinalizedAttendance?: boolean;
    telegramStatus?: 'creator' | 'administrator' | 'member' | 'left';
    actions?: Partial<ManagementActions>;
    summary?: ManagementSummary;
  } = {},
) => {
  const game = options.game ?? managedGame();
  const record = {
    groupId,
    gameId,
    userId,
    telegramChatId: asTelegramId('-1001'),
    game,
    gameState: game.state,
    dmAvailable: options.dmAvailable ?? true,
    registrationCount: 3,
    rosterCount: 2,
    waitlistCount: 1,
    hasFinalizedAttendance: options.hasFinalizedAttendance ?? true,
    canonicalPinFailedAt: null,
  };
  let editSession: GameEditSession | null = null;
  const directory = {
    resolveGameGroup: vi.fn().mockResolvedValue({
      groupId,
      telegramChatId: asTelegramId('-1001'),
    }),
    refreshMembership: vi.fn().mockResolvedValue(userId),
    resolve: vi.fn().mockResolvedValue(record),
    markPrivateAvailable: vi.fn(),
    markPrivateUnavailable: vi.fn(),
    startEditSession: vi.fn().mockImplementation(async (input) => {
      const now = new Date('2026-09-06T12:00:00.000Z');
      editSession = {
        ...input,
        interactionRevision: 0,
        pendingChanges: null,
        createdAt: now,
        updatedAt: now,
      };
      return editSession;
    }),
    resolveLatestEditScope: vi.fn().mockImplementation(async () =>
      editSession === null
        ? null
        : {
            groupId: editSession.groupId,
            actorUserId: editSession.actorUserId,
          },
    ),
    loadEditSession: vi.fn().mockImplementation(async () => editSession),
    saveEditSessionChanges: vi.fn().mockImplementation(async (input) => {
      if (
        editSession === null ||
        editSession.groupId !== input.groupId ||
        editSession.actorUserId !== input.actorUserId ||
        editSession.gameId !== input.gameId ||
        editSession.expectedGameRevision !== input.expectedGameRevision ||
        editSession.interactionRevision !== input.expectedInteractionRevision
      ) {
        return null;
      }
      editSession = {
        ...editSession,
        interactionRevision: editSession.interactionRevision + 1,
        pendingChanges: input.pendingChanges,
        updatedAt: new Date('2026-09-06T12:01:00.000Z'),
      };
      return editSession;
    }),
    clearEditSession: vi.fn().mockImplementation(async () => {
      editSession = null;
      return true;
    }),
    loadSummary: vi.fn().mockResolvedValue(
      options.summary ?? {
        participationCount: 0,
        attendance: null,
        settlement: null,
      },
    ),
  };
  const telegram = {
    getChatMember: vi.fn().mockResolvedValue({
      status: options.telegramStatus ?? 'administrator',
    }),
  };
  const actions = {
    changeState:
      options.actions?.changeState ?? vi.fn().mockResolvedValue(game),
    deleteDraft:
      options.actions?.deleteDraft ?? vi.fn().mockResolvedValue(undefined),
    update:
      options.actions?.update ??
      vi.fn().mockResolvedValue({
        game,
        rosterCount: record.rosterCount,
        waitlistCount: record.waitlistCount,
        materialFields: [],
      }),
    ...(options.actions?.listGames === undefined
      ? {}
      : { listGames: options.actions.listGames }),
  };
  return {
    directory,
    telegram,
    actions,
    handlers: new ManagementEntryHandlers(
      directory,
      {
        requireOrganizer: vi.fn().mockImplementation(async () => {
          if (options.telegramStatus === 'left') {
            throw new AuthorizationDeniedError();
          }
        }),
      },
      telegram,
      actions,
    ),
  };
};

const managedGame = (overrides: Partial<Game> = {}): Game => ({
  id: gameId,
  groupId,
  sourceTemplateId: null,
  name: 'Вечерняя игра',
  venue: 'Арена',
  address: null,
  startsAt: new Date('2026-09-10T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 12,
  timeZone: 'Europe/Astrakhan',
  registrationOpensAt: new Date('2026-09-01T16:00:00.000Z'),
  registrationClosesAt: new Date('2026-09-10T15:00:00.000Z'),
  tentativePromptAt: new Date('2026-09-09T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-09T17:00:00.000Z'),
  reminderAt: new Date('2026-09-10T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'OPEN',
  revision: 4,
  scheduleRevision: 0,
  canonicalTelegramMessageId: 5n,
  ...overrides,
});

const botHarness = (handlers: ManagementEntryHandlers) => {
  const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> =
    [];
  const bot = createTelegramBot('123456:abcdefghijklmnopqrstuvwxyz', {
    id: 999,
    is_bot: true,
    first_name: 'Volley',
    username: 'volley_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  });
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  registerManagementEntryHandlers(
    bot,
    handlers,
    { start: vi.fn() } as never,
    { start: vi.fn() } as never,
  );
  return {
    apiCalls,
    handle: (
      update: ReturnType<typeof callbackUpdate> | ReturnType<typeof textUpdate>,
    ) => createLazyTelegramUpdateHandler(bot).handleUpdate(update as never),
  };
};

const callbackUpdate = (data: string, privateChat: boolean) => ({
  update_id: Math.floor(Math.random() * 100_000),
  callback_query: {
    id: `manage-${Math.random()}`,
    chat_instance: 'manage',
    from: { id: 42, is_bot: false, first_name: 'Ada' },
    data,
    message: {
      message_id: 1,
      date: 1,
      chat: privateChat
        ? { id: 42, type: 'private', first_name: 'Ada' }
        : { id: -1001, type: 'supergroup', title: 'Group' },
      text: 'game',
    },
  },
});

const textUpdate = (text: string) => ({
  update_id: Math.floor(Math.random() * 100_000),
  message: {
    message_id: 2,
    date: 1,
    chat: { id: 42, type: 'private', first_name: 'Ada' },
    from: { id: 42, is_bot: false, first_name: 'Ada' },
    text,
  },
});
