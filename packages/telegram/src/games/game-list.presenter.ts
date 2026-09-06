import { asGameId, type Game, type GameId } from '@volley/domain';
import {
  editableFields,
  type GameEditableField,
  type GameListBucket,
  type GameUpdateChanges,
} from '@volley/application';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import {
  compactGameUuid,
  expandGameCompactUuid,
} from './game-creation.model.js';

type StaticGameAction =
  | 'view'
  | 'manage'
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

export type GameEditField = Exclude<GameEditableField, 'currency'>;
export type GameEditFieldCode =
  | 'n'
  | 'v'
  | 'a'
  | 's'
  | 'd'
  | 'c'
  | 'o'
  | 'x'
  | 'p'
  | 'q'
  | 'r'
  | 'm'
  | 'k'
  | 'g';
type GameEditAction = `edit-${GameEditFieldCode}` | `edit-confirm-${string}`;
export type GameAction = StaticGameAction | GameEditAction;

export type VisibleGameListBucket = Exclude<GameListBucket, 'CANCELLED'>;

export interface ManagementGameView {
  game: Game;
  registrationCount: number;
  rosterCount: number;
  waitlistCount: number;
  hasFinalizedAttendance: boolean;
  canonicalPinFailedAt: Date | null;
}

export interface ManagementSummaryView {
  participationCount: number;
  attendance: {
    presentCount: number;
    billableCount: number;
  } | null;
  settlement: {
    totalMinor: bigint;
    paidCount: number;
    paidMinor: bigint;
    unpaidCount: number;
    unpaidMinor: bigint;
    waivedCount: number;
    waivedMinor: bigint;
  } | null;
}

export const gameActionCallback = (
  action: GameAction,
  gameId: GameId,
  revision: number,
): string => {
  if (
    !isGameAction(action ?? '') ||
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
    !isGameAction(action ?? '') ||
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

export const gameEditFieldAction = (
  field: GameEditField,
): `edit-${GameEditFieldCode}` => `edit-${gameEditFieldCodes[field]}`;

export const parseGameEditAction = (
  action: GameAction,
):
  | { kind: 'FIELD'; field: GameEditField }
  | { kind: 'CONFIRM'; interactionRevision: number }
  | null => {
  const field = gameEditFieldsByAction.get(action);
  if (field !== undefined) return { kind: 'FIELD', field };
  const match = /^edit-confirm-([0-9a-z]+)$/.exec(action);
  if (match === null) return null;
  const interactionRevision = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(interactionRevision) &&
    interactionRevision >= 0 &&
    interactionRevision <= 2_147_483_647 &&
    interactionRevision.toString(36) === match[1]
    ? { kind: 'CONFIRM', interactionRevision }
    : null;
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

export const renderGameEditFields = (
  input: ManagementGameView,
  notice?: string,
): OrganizerView => {
  const allowed = new Set(
    editableFields({
      state: input.game.state,
      registrationCount: input.registrationCount,
    }),
  );
  const fields = gameEditFields.filter((field) => allowed.has(field));
  return {
    text: [notice, '<b>Изменение игры</b>', 'Выберите поле для изменения.']
      .filter(Boolean)
      .join('\n\n'),
    parseMode: 'HTML',
    keyboard: [
      ...fields.map((field) => [
        {
          text: gameEditFieldLabels[field],
          callbackData: gameActionCallback(
            gameEditFieldAction(field),
            requiredGameId(input.game),
            input.game.revision,
          ),
        },
      ]),
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
  };
};

export const renderGameEditInput = (
  input: ManagementGameView,
  field: GameEditField,
  notice?: string,
): OrganizerView => ({
  text: [
    notice,
    `<b>${gameEditFieldLabels[field]}</b>`,
    gameEditFieldHints[field],
  ]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Назад',
        callbackData: gameActionCallback(
          'edit',
          requiredGameId(input.game),
          input.game.revision,
        ),
      },
    ],
  ],
});

export const renderGameEditConfirmation = (
  input: ManagementGameView,
  session: {
    selectedField: GameEditField;
    interactionRevision: number;
    pendingChanges: GameUpdateChanges;
  },
): OrganizerView => {
  const field = session.selectedField;
  return {
    text: [
      '<b>Подтвердите изменение</b>',
      `Поле: ${gameEditFieldLabels[field]}`,
      `Было: ${escapeHtml(formatGameFieldValue(input.game[field], field, input.game.timeZone))}`,
      `Стало: ${escapeHtml(formatGameFieldValue(session.pendingChanges[field], field, input.game.timeZone))}`,
    ].join('\n'),
    parseMode: 'HTML',
    keyboard: [
      [
        {
          text: 'Сохранить изменение',
          callbackData: gameActionCallback(
            `edit-confirm-${session.interactionRevision.toString(36)}`,
            requiredGameId(input.game),
            input.game.revision,
          ),
        },
      ],
      [
        {
          text: 'Назад',
          callbackData: gameActionCallback(
            gameEditFieldAction(field),
            requiredGameId(input.game),
            input.game.revision,
          ),
        },
      ],
    ],
  };
};

export const renderGameSummary = (
  input: ManagementGameView,
  summary: ManagementSummaryView,
): OrganizerView => ({
  text: [
    '<b>Итоги игры</b>',
    `<b>${escapeHtml(input.game.name)}</b>`,
    `Зарегистрировано: ${summary.participationCount}`,
    summary.attendance === null
      ? 'Посещаемость ещё не подтверждена.'
      : [
          `Присутствовали: ${summary.attendance.presentCount}`,
          `Участвуют в расчёте: ${summary.attendance.billableCount}`,
        ].join('\n'),
    summary.settlement === null
      ? 'Расчёт оплат ещё не создан.'
      : [
          `Сумма игры: ${costLabel(summary.settlement.totalMinor)}`,
          `Оплачено: ${summary.settlement.paidCount} на ${costLabel(summary.settlement.paidMinor)}`,
          `Не оплачено: ${summary.settlement.unpaidCount} на ${costLabel(summary.settlement.unpaidMinor)}`,
          `Без оплаты: ${summary.settlement.waivedCount} на ${costLabel(summary.settlement.waivedMinor)}`,
        ].join('\n'),
  ].join('\n'),
  parseMode: 'HTML',
  keyboard: [
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
  'manage',
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

const gameEditFields = [
  'name',
  'venue',
  'address',
  'startsAt',
  'durationMinutes',
  'capacity',
  'registrationOpensAt',
  'registrationClosesAt',
  'tentativePromptAt',
  'tentativeResponseDeadline',
  'reminderAt',
  'memberPriorityEnabled',
  'totalCostMinor',
  'roundingMode',
] as const satisfies readonly GameEditField[];

const gameEditFieldCodes: Record<GameEditField, GameEditFieldCode> = {
  name: 'n',
  venue: 'v',
  address: 'a',
  startsAt: 's',
  durationMinutes: 'd',
  capacity: 'c',
  registrationOpensAt: 'o',
  registrationClosesAt: 'x',
  tentativePromptAt: 'p',
  tentativeResponseDeadline: 'q',
  reminderAt: 'r',
  memberPriorityEnabled: 'm',
  totalCostMinor: 'k',
  roundingMode: 'g',
};

const gameEditFieldsByAction = new Map<GameAction, GameEditField>(
  gameEditFields.map((field) => [gameEditFieldAction(field), field]),
);

const gameEditFieldLabels: Record<GameEditField, string> = {
  name: 'Название',
  venue: 'Место',
  address: 'Адрес',
  startsAt: 'Дата и время начала',
  durationMinutes: 'Длительность',
  capacity: 'Количество мест',
  registrationOpensAt: 'Открытие регистрации',
  registrationClosesAt: 'Закрытие регистрации',
  tentativePromptAt: 'Запрос подтверждения',
  tentativeResponseDeadline: 'Время на ответ',
  reminderAt: 'Напоминание',
  memberPriorityEnabled: 'Приоритет участников группы',
  totalCostMinor: 'Общая стоимость',
  roundingMode: 'Округление',
};

const gameEditFieldHints: Record<GameEditField, string> = {
  name: 'Отправьте название игры.',
  venue: 'Отправьте название площадки.',
  address: 'Отправьте адрес или «-», если адрес не нужен.',
  startsAt: 'Отправьте дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ.',
  durationMinutes: 'Отправьте длительность в минутах (15–720).',
  capacity: 'Отправьте количество мест (1–200).',
  registrationOpensAt: 'За сколько минут до игры открыть регистрацию?',
  registrationClosesAt:
    'За сколько минут до игры закрыть регистрацию? «-» — не закрывать заранее.',
  tentativePromptAt:
    'За сколько минут до игры запросить подтверждение участия?',
  tentativeResponseDeadline:
    'Сколько минут после запроса дать участникам на ответ?',
  reminderAt: 'За сколько минут до игры отправить напоминание?',
  memberPriorityEnabled: 'Отправьте «да» или «нет».',
  totalCostMinor:
    'Отправьте сумму в рублях или «-», если стоимость неизвестна.',
  roundingMode: 'Отправьте «точно», «1», «10» или «50».',
};

const isGameAction = (action: string): action is GameAction =>
  gameActions.has(action as GameAction) ||
  /^edit-(?:n|v|a|s|d|c|o|x|p|q|r|m|k|g)$/.test(action) ||
  /^edit-confirm-(?:0|[1-9a-z][0-9a-z]*)$/.test(action);

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

const formatGameFieldValue = (
  value: Game[GameEditableField] | undefined,
  field: GameEditField,
  timeZone: string,
): string => {
  if (value === null || value === undefined) return 'не указано';
  if (
    field === 'startsAt' ||
    field === 'registrationOpensAt' ||
    field === 'registrationClosesAt' ||
    field === 'tentativePromptAt' ||
    field === 'tentativeResponseDeadline' ||
    field === 'reminderAt'
  ) {
    return formatDateTime(value as Date, timeZone);
  }
  if (field === 'durationMinutes') return `${String(value)} мин`;
  if (field === 'capacity') return String(value);
  if (field === 'memberPriorityEnabled') return value ? 'да' : 'нет';
  if (field === 'totalCostMinor') return costLabel(value as bigint);
  if (field === 'roundingMode') {
    return (
      {
        EXACT: 'точно до копеек',
        UP_1: 'до 1 ₽ вверх',
        UP_10: 'до 10 ₽ вверх',
        UP_50: 'до 50 ₽ вверх',
      } as const
    )[value as Game['roundingMode']];
  }
  return String(value);
};

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
