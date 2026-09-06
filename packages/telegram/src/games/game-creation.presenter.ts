import type {
  GameCreationDraft,
  OrganizerGroupCandidate,
} from '@volley/application';
import type { GameTemplate } from '@volley/domain';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import type { SettingsEditorField } from '../organizer/settings-editor.model.js';
import { renderGamePreview } from '../messages/game-preview.renderer.js';
import {
  compactGameUuid,
  gameDraftControlId,
  gameEditorFields,
  gameFieldCode,
} from './game-creation.model.js';

export const gameCreationCallback = (
  action: string,
  opaqueId?: string,
): string => {
  const value = `gc:v1:${action}${opaqueId === undefined ? '' : `:${opaqueId}`}`;
  if (Buffer.byteLength(value, 'utf8') >= 64)
    throw new Error('Telegram callback payload must be under 64 bytes');
  return value;
};

export const renderGameGroupPicker = (
  groups: readonly OrganizerGroupCandidate[],
): OrganizerView => ({
  text:
    groups.length === 0
      ? 'У вас нет доступных групп. Добавьте бота в группу и завершите настройку.'
      : '<b>Выберите группу для игры</b>',
  parseMode: 'HTML',
  keyboard: groups.map((group) => [
    {
      text: group.title,
      callbackData: gameCreationCallback('g', compactGameUuid(group.groupId)),
    },
  ]),
});

export const renderGameDraftResume = (
  draft: GameCreationDraft,
): OrganizerView => ({
  text: '<b>Создание игры уже начато</b>\n\nПродолжить с сохранённого шага или начать заново?',
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Продолжить',
        callbackData: draftCallback('c', draft),
      },
    ],
    [
      {
        text: 'Начать заново',
        callbackData: draftCallback('r', draft),
      },
    ],
  ],
});

export interface GameTemplateChoiceInput {
  draft: GameCreationDraft;
  templates: readonly GameTemplate[];
  notice?: string;
}

export const renderGameTemplateChoice = (
  input: GameTemplateChoiceInput,
): OrganizerView => ({
  text: [
    input.notice,
    '<b>Выберите шаблон игры</b>',
    input.templates.length === 0
      ? 'Нет активных шаблонов. Сначала создайте шаблон через /templates.'
      : 'Настройки шаблона будут скопированы в игру.',
  ]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    ...input.templates.map((template) => [
      {
        text: template.name,
        callbackData: gameCreationCallback(
          't',
          `${compactGameUuid(template.id)}.${gameDraftControlId(input.draft)}`,
        ),
      },
    ]),
    [
      {
        text: 'Отмена',
        callbackData: draftCallback('x', input.draft),
      },
    ],
  ],
});

export const renderGameDateStep = (
  draft: GameCreationDraft,
  timeZone: string,
  notice?: string,
): OrganizerView => ({
  text: [
    notice,
    '<b>Дата игры</b>',
    `Отправьте дату в формате ДД.ММ.ГГГГ. Время из шаблона: ${draft.snapshot?.startsAtLocalTime ?? '—'} (${escapeHtml(timeZone)}).`,
  ]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: navigationKeyboard(draft),
});

export const renderGameCustomize = (
  draft: GameCreationDraft,
  notice?: string,
): OrganizerView => ({
  text: [
    notice,
    '<b>Настройки игры</b>',
    'При необходимости измените скопированные значения или откройте предпросмотр.',
  ]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    ...gameEditorFields.map((field) => [
      {
        text: fieldLabel(field),
        callbackData: gameCreationCallback(
          'e',
          `${gameFieldCode(field)}.${gameDraftControlId(draft)}`,
        ),
      },
    ]),
    [
      {
        text: 'Предпросмотр',
        callbackData: draftCallback('p', draft),
      },
    ],
    ...navigationKeyboard(draft),
  ],
});

export const renderGameFieldEditor = (
  draft: GameCreationDraft,
  field: SettingsEditorField,
  notice?: string,
): OrganizerView => ({
  text: [notice, `<b>${fieldLabel(field)}</b>`, fieldHint(field)]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    ...fieldChoices(field, draft),
    [
      {
        text: 'Назад',
        callbackData: draftCallback('b', draft),
      },
    ],
    [
      {
        text: 'Отмена',
        callbackData: draftCallback('x', draft),
      },
    ],
  ],
});

export const renderGamePreviewView = (
  draft: GameCreationDraft,
  timeZone: string,
  now: Date,
  notice?: string,
): OrganizerView => ({
  text: [
    notice,
    '<b>Проверьте игру</b>',
    renderGamePreview({
      source: draft.templateId ?? 'scratch',
      startsAtIso: draft.startsAtIso!,
      settings: draft.snapshot,
      timeZone,
      now,
    }),
  ]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Опубликовать',
        callbackData: draftCallback('u', draft),
      },
    ],
    [
      {
        text: 'Изменить',
        callbackData: draftCallback('b', draft),
      },
    ],
    [
      {
        text: 'Сохранить черновик',
        callbackData: draftCallback('k', draft),
      },
    ],
    [
      {
        text: 'Отмена',
        callbackData: draftCallback('x', draft),
      },
    ],
  ],
});

export const renderGameCancelConfirmation = (
  draft: GameCreationDraft,
  notice?: string,
): OrganizerView => ({
  text: [notice, 'Отменить создание игры?'].filter(Boolean).join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Да, отменить',
        callbackData: draftCallback('y', draft),
      },
    ],
    [
      {
        text: 'Нет',
        callbackData: draftCallback('n', draft),
      },
    ],
  ],
});

export const renderGameDraftSaved = (
  draft: GameCreationDraft,
): OrganizerView => ({
  text: 'Черновик сохранён. Вы сможете продолжить через /newgame.',
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Продолжить',
        callbackData: draftCallback('c', draft),
      },
    ],
    [
      {
        text: 'Начать заново',
        callbackData: draftCallback('r', draft),
      },
    ],
  ],
});

export const renderGameCancelled = (): OrganizerView => ({
  text: 'Создание игры отменено.',
  parseMode: 'HTML',
  keyboard: [],
});

export const renderGamePublished = (
  draft?: GameCreationDraft,
): OrganizerView => ({
  text: '✅ Игра опубликована\nКарточка появится в группе. Если закрепление недоступно, предупреждение будет показано в управлении игрой.',
  parseMode: 'HTML',
  keyboard:
    draft === undefined
      ? []
      : [
          [
            {
              text: 'Начать новую игру',
              callbackData: draftCallback('r', draft),
            },
          ],
        ],
});

const draftCallback = (action: string, draft: GameCreationDraft): string =>
  gameCreationCallback(action, gameDraftControlId(draft));

const navigationKeyboard = (
  draft: GameCreationDraft,
): OrganizerView['keyboard'] => [
  [
    {
      text: 'Назад',
      callbackData: draftCallback('b', draft),
    },
  ],
  [
    {
      text: 'Отмена',
      callbackData: draftCallback('x', draft),
    },
  ],
];

const fieldChoices = (
  field: SettingsEditorField,
  draft: GameCreationDraft,
): OrganizerView['keyboard'] => {
  const callback = (choice: string) =>
    gameCreationCallback('s', `${choice}.${gameDraftControlId(draft)}`);
  if (field === 'MEMBER_PRIORITY')
    return [
      [
        { text: 'Да', callbackData: callback('y') },
        { text: 'Нет', callbackData: callback('n') },
      ],
    ];
  if (field === 'ROUNDING')
    return [
      [{ text: 'Точно до копеек', callbackData: callback('e') }],
      [{ text: 'До 1 ₽ вверх', callbackData: callback('1') }],
      [{ text: 'До 10 ₽ вверх', callbackData: callback('a') }],
      [{ text: 'До 50 ₽ вверх', callbackData: callback('f') }],
    ];
  return [];
};

const fieldLabel = (field: SettingsEditorField): string =>
  ({
    NAME: 'Название',
    VENUE: 'Место',
    ADDRESS: 'Адрес',
    TIME: 'Время начала',
    DURATION: 'Длительность',
    CAPACITY: 'Количество мест',
    OPENING: 'Открытие регистрации',
    CLOSING: 'Закрытие регистрации',
    CONFIRMATION_PROMPT: 'Запрос подтверждения',
    CONFIRMATION_RESPONSE: 'Время на ответ',
    REMINDER: 'Напоминание',
    MEMBER_PRIORITY: 'Приоритет участников группы',
    COST: 'Общая стоимость',
    ROUNDING: 'Округление',
  })[field];

const fieldHint = (field: SettingsEditorField): string =>
  ({
    NAME: 'Отправьте название игры.',
    VENUE: 'Отправьте название площадки.',
    ADDRESS: 'Отправьте адрес или «-», если адрес не нужен.',
    TIME: 'Отправьте время в формате ЧЧ:ММ.',
    DURATION: 'Отправьте длительность в минутах (15–720).',
    CAPACITY: 'Отправьте количество мест (1–200).',
    OPENING: 'За сколько минут открыть регистрацию?',
    CLOSING:
      'За сколько минут закрыть регистрацию? «-» — не закрывать заранее.',
    CONFIRMATION_PROMPT: 'За сколько минут запросить подтверждение?',
    CONFIRMATION_RESPONSE: 'Сколько минут дать на ответ?',
    REMINDER: 'За сколько минут напомнить об игре?',
    MEMBER_PRIORITY: 'Давать участникам группы приоритет?',
    COST: 'Отправьте сумму в рублях или «-», если стоимость неизвестна.',
    ROUNDING: 'Как округлять долю участника?',
  })[field];

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
