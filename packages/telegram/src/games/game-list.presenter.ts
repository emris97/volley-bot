import { asGameId, type Game, type GameId } from '@volley/domain';
import type { GameListBucket } from '@volley/application';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import {
  compactGameUuid,
  expandGameCompactUuid,
} from './game-creation.model.js';

export type GameAction =
  | 'view'
  | 'edit'
  | 'publish'
  | 'publish-confirm'
  | 'delete'
  | 'delete-confirm'
  | 'open'
  | 'open-confirm'
  | 'close'
  | 'close-confirm'
  | 'reopen'
  | 'reopen-confirm'
  | 'complete'
  | 'complete-confirm'
  | 'cancel'
  | 'cancel-confirm'
  | 'attendance'
  | 'payment'
  | 'summary'
  | 'next-u'
  | 'next-h';

export type VisibleGameListBucket = Exclude<GameListBucket, 'CANCELLED'>;

export interface ManagementGameView {
  game: Game;
  registrationCount: number;
  rosterCount: number;
  waitlistCount: number;
  hasFinalizedAttendance: boolean;
  canonicalPinFailedAt: Date | null;
}

export const gameActionCallback = (
  action: GameAction,
  gameId: GameId,
  revision: number,
): string => {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > 2_147_483_647
  ) {
    throw new Error('Некорректная кнопка управления игрой.');
  }
  const callback = `ga:v1:${action}:${compactGameUuid(gameId)}:${revision.toString(36)}`;
  if (Buffer.byteLength(callback, 'utf8') >= 64) {
    throw new Error('Кнопка управления игрой превышает 64 байта.');
  }
  return callback;
};

export const parseGameActionCallback = (
  value: string,
): { action: GameAction; gameId: GameId; revision: number } => {
  const [namespace, version, action, compactId, revisionCode, ...rest] =
    value.split(':');
  const revision = Number.parseInt(revisionCode ?? '', 36);
  if (
    namespace !== 'ga' ||
    version !== 'v1' ||
    !gameActions.has(action as GameAction) ||
    compactId === undefined ||
    !/^[0-9a-z]+$/.test(revisionCode ?? '') ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > 2_147_483_647 ||
    revision.toString(36) !== revisionCode ||
    rest.length > 0
  ) {
    throw new Error('Некорректная кнопка управления игрой.');
  }
  try {
    const expandedGameId = expandGameCompactUuid(compactId);
    if (compactGameUuid(expandedGameId) !== compactId) {
      throw new Error('Non-canonical compact UUID');
    }
    return {
      action: action as GameAction,
      gameId: asGameId(expandedGameId),
      revision,
    };
  } catch {
    throw new Error('Некорректная кнопка управления игрой.');
  }
};

export const renderGameList = (input: {
  bucket: VisibleGameListBucket;
  items: readonly Game[];
  nextCursor: GameId | null;
  timeZone: string;
  notice?: string;
}): OrganizerView => {
  if (input.items.length > 8) throw new Error('Game list exceeds eight items');
  const heading =
    input.bucket === 'UPCOMING' ? 'Предстоящие игры' : 'Прошедшие игры';
  const empty =
    input.bucket === 'UPCOMING'
      ? 'Предстоящих игр пока нет.'
      : 'Прошедших игр пока нет.';
  const cursor = input.items.at(-1);
  return {
    text: [
      input.notice,
      `<b>${heading}</b>`,
      input.items.length === 0 ? empty : 'Выберите игру:',
    ]
      .filter(Boolean)
      .join('\n\n'),
    parseMode: 'HTML',
    keyboard: [
      ...input.items.map((game) => [
        {
          text: `${formatDate(game.startsAt, input.timeZone)} · ${game.name}`,
          callbackData: gameActionCallback(
            'view',
            requiredGameId(game),
            game.revision,
          ),
        },
      ]),
      ...(input.nextCursor === null || cursor === undefined
        ? []
        : [
            [
              {
                text: 'Далее',
                callbackData: gameActionCallback(
                  nextAction(input.bucket),
                  input.nextCursor,
                  cursor.revision,
                ),
              },
            ],
          ]),
      [{ text: 'Назад', callbackData: 'om:v1:home' }],
    ],
  };
};

export const renderGameManagement = (
  input: ManagementGameView,
  notice?: string,
): OrganizerView => {
  const { game } = input;
  return {
    text: [
      notice,
      '<b>Управление игрой</b>',
      `<b>${escapeHtml(game.name)}</b>`,
      `📍 ${escapeHtml(game.venue)}${game.address === null ? '' : ` — ${escapeHtml(game.address)}`}`,
      `🗓 ${formatDateTime(game.startsAt, game.timeZone)}`,
      `Статус: ${stateLabel(game.state)}`,
      `Состав: ${input.rosterCount}/${game.capacity}`,
      `Резерв: ${input.waitlistCount}`,
      `Стоимость: ${costLabel(game.totalCostMinor)}`,
      ...(input.canonicalPinFailedAt === null
        ? []
        : ['⚠️ Карточку игры не удалось закрепить в группе.']),
    ]
      .filter(Boolean)
      .join('\n'),
    parseMode: 'HTML',
    keyboard: [
      ...actionsFor(game.state).map(({ text, action }) => [
        {
          text,
          callbackData: gameActionCallback(
            action,
            requiredGameId(game),
            game.revision,
          ),
        },
      ]),
      [{ text: 'К списку', callbackData: 'om:v1:games:upcoming' }],
    ],
  };
};

export const renderGameActionConfirmation = (
  input: ManagementGameView,
  action: ConfirmableGameAction,
): OrganizerView => ({
  text: `<b>${escapeHtml(input.game.name)}</b>\n\n${confirmationQuestion[action]}`,
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: confirmationLabel[action],
        callbackData: gameActionCallback(
          `${action}-confirm`,
          requiredGameId(input.game),
          input.game.revision,
        ),
      },
    ],
    [
      {
        text: 'Назад',
        callbackData: gameActionCallback(
          'view',
          requiredGameId(input.game),
          input.game.revision,
        ),
      },
    ],
  ],
});

export type ConfirmableGameAction =
  'publish' | 'delete' | 'open' | 'close' | 'reopen' | 'complete' | 'cancel';

const actionsByState: Record<
  Game['state'],
  readonly { text: string; action: GameAction }[]
> = {
  DRAFT: [
    { text: 'Изменить', action: 'edit' },
    { text: 'Опубликовать', action: 'publish' },
    { text: 'Удалить черновик', action: 'delete' },
  ],
  SCHEDULED: [
    { text: 'Изменить', action: 'edit' },
    { text: 'Открыть регистрацию', action: 'open' },
    { text: 'Отменить игру', action: 'cancel' },
  ],
  OPEN: [
    { text: 'Изменить', action: 'edit' },
    { text: 'Закрыть регистрацию', action: 'close' },
    { text: 'Отменить игру', action: 'cancel' },
  ],
  CLOSED: [
    { text: 'Открыть регистрацию снова', action: 'reopen' },
    { text: 'Завершить игру', action: 'complete' },
    { text: 'Отменить игру', action: 'cancel' },
  ],
  COMPLETED: [
    { text: 'Посещаемость', action: 'attendance' },
    { text: 'Расчёт оплат', action: 'payment' },
    { text: 'Итоги', action: 'summary' },
  ],
  CANCELLED: [],
};

const actionsFor = (
  state: Game['state'],
): readonly { text: string; action: GameAction }[] => actionsByState[state];

const confirmationQuestion: Record<ConfirmableGameAction, string> = {
  publish: 'Опубликовать игру?',
  delete: 'Удалить черновик?',
  open: 'Открыть регистрацию?',
  close: 'Закрыть регистрацию?',
  reopen: 'Открыть регистрацию снова?',
  complete: 'Завершить игру?',
  cancel: 'Отменить игру?',
};

const confirmationLabel: Record<ConfirmableGameAction, string> = {
  publish: 'Да, опубликовать',
  delete: 'Да, удалить',
  open: 'Да, открыть',
  close: 'Да, закрыть',
  reopen: 'Да, открыть снова',
  complete: 'Да, завершить',
  cancel: 'Да, отменить',
};

const gameActions = new Set<GameAction>([
  'view',
  'edit',
  'publish',
  'publish-confirm',
  'delete',
  'delete-confirm',
  'open',
  'open-confirm',
  'close',
  'close-confirm',
  'reopen',
  'reopen-confirm',
  'complete',
  'complete-confirm',
  'cancel',
  'cancel-confirm',
  'attendance',
  'payment',
  'summary',
  'next-u',
  'next-h',
]);

const nextAction = (bucket: VisibleGameListBucket): GameAction =>
  bucket === 'UPCOMING' ? 'next-u' : 'next-h';

const requiredGameId = (game: Game): GameId => {
  if (game.id === undefined) throw new Error('Game id is required');
  return game.id;
};

const stateLabel = (state: Game['state']): string =>
  ({
    DRAFT: 'черновик',
    SCHEDULED: 'запланирована',
    OPEN: 'регистрация открыта',
    CLOSED: 'регистрация закрыта',
    COMPLETED: 'завершена',
    CANCELLED: 'отменена',
  })[state];

const costLabel = (minor: bigint | null): string =>
  minor === null
    ? 'не указана'
    : `${new Intl.NumberFormat('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(minor) / 100)} ₽`;

const formatDate = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);

const formatDateTime = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
