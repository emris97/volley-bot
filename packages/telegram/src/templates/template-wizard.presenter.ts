import type { GameTemplate, GameTemplateId } from '@volley/domain';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import type { TemplateWizardStep } from '../organizer/settings-editor.model.js';
import {
  templateDraftControlId,
  type TemplateWizardDraft,
} from './template-wizard.model.js';

export interface TemplateListViewInput {
  items: readonly GameTemplate[];
  nextCursor: GameTemplateId | null;
  archived: boolean;
  notice?: string;
}

export const renderTemplateList = (
  input: TemplateListViewInput,
): OrganizerView => ({
  text: [
    input.notice,
    `<b>${input.archived ? 'Архив шаблонов' : 'Шаблоны'}</b>`,
    input.items.length === 0 ? 'Здесь пока нет шаблонов.' : 'Выберите шаблон:',
  ]
    .filter(Boolean)
    .join('\n\n'),
  parseMode: 'HTML',
  keyboard: [
    ...input.items.map((template) => [
      {
        text: template.name,
        callbackData: templateCallback('open', compactUuid(template.id)),
      },
    ]),
    ...(input.nextCursor === null
      ? []
      : [
          [
            {
              text: 'Далее',
              callbackData: templateCallback(
                input.archived ? 'next-archived' : 'next',
                compactUuid(input.nextCursor),
              ),
            },
          ],
        ]),
    ...(input.archived
      ? [[{ text: 'Активные', callbackData: templateCallback('active') }]]
      : [
          [
            {
              text: 'Создать шаблон',
              callbackData: templateCallback('create'),
            },
          ],
          [{ text: 'Архив', callbackData: templateCallback('archived') }],
        ]),
    [{ text: 'Назад', callbackData: 'om:v1:home' }],
  ],
});

export const renderTemplateDetails = (
  template: GameTemplate,
): OrganizerView => ({
  text: [
    `<b>${escapeHtml(template.name)}</b>`,
    `${escapeHtml(template.venue)} · ${template.startsAtLocalTime} · ${template.durationMinutes} мин`,
    `Мест: ${template.capacity}`,
    template.archivedAt === null ? 'Активен' : 'В архиве',
  ].join('\n'),
  parseMode: 'HTML',
  keyboard:
    template.archivedAt === null
      ? [
          [
            {
              text: 'Создать игру',
              callbackData: templateCallback('game', compactUuid(template.id)),
            },
          ],
          [
            {
              text: 'Изменить',
              callbackData: templateCallback('edit', compactUuid(template.id)),
            },
            {
              text: 'Копировать',
              callbackData: templateCallback('copy', compactUuid(template.id)),
            },
          ],
          [
            {
              text: 'В архив',
              callbackData: templateCallback(
                'archive',
                `${compactUuid(template.id)}.${template.revision.toString(36)}`,
              ),
            },
          ],
          [{ text: 'Назад', callbackData: templateCallback('active') }],
        ]
      : [
          [
            {
              text: 'Восстановить',
              callbackData: templateCallback(
                'restore',
                `${compactUuid(template.id)}.${template.revision.toString(36)}`,
              ),
            },
          ],
          [{ text: 'Назад', callbackData: templateCallback('archived') }],
        ],
});

export const renderTemplateDraftResume = (
  draft: TemplateWizardDraft,
): OrganizerView => {
  const control = templateDraftControlId(draft);
  return {
    text: '<b>Незавершённый шаблон</b>\n\nПродолжить с сохранённого шага или начать заново?',
    parseMode: 'HTML',
    keyboard: [
      [
        {
          text: 'Продолжить',
          callbackData: templateCallback('continue', control),
        },
      ],
      [
        {
          text: 'Начать заново',
          callbackData: templateCallback('restart', control),
        },
      ],
      [{ text: 'Назад', callbackData: 'om:v1:home' }],
    ],
  };
};

export const renderTemplateArchiveConfirmation = (
  template: GameTemplate,
): OrganizerView => ({
  text: `<b>${escapeHtml(template.name)}</b>\n\nАрхивировать шаблон? Созданные ранее игры не изменятся.`,
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Да, архивировать',
        callbackData: templateCallback(
          'archive-confirm',
          `${compactUuid(template.id)}.${template.revision.toString(36)}`,
        ),
      },
    ],
    [
      {
        text: 'Нет',
        callbackData: templateCallback('open', compactUuid(template.id)),
      },
    ],
  ],
});

export const renderTemplateWizard = (
  draft: TemplateWizardDraft,
  error?: string,
): OrganizerView => {
  const callback = (action: string) =>
    templateCallback(action, templateDraftControlId(draft));
  if (draft.step === 'PREVIEW') {
    return {
      text: [error, '<b>Проверьте шаблон</b>', snapshotSummary(draft)]
        .filter(Boolean)
        .join('\n\n'),
      parseMode: 'HTML',
      keyboard: [
        [{ text: 'Сохранить', callbackData: callback('save') }],
        [{ text: 'Назад', callbackData: callback('back') }],
        [{ text: 'Отмена', callbackData: callback('cancel') }],
      ],
    };
  }
  const buttonRows = choiceRows(draft.step, callback);
  return {
    text: [error, `<b>${stepTitle(draft.step)}</b>`, stepHint(draft.step)]
      .filter(Boolean)
      .join('\n\n'),
    parseMode: 'HTML',
    keyboard: [
      ...buttonRows,
      ...(draft.step === 'NAME'
        ? []
        : [[{ text: 'Назад', callbackData: callback('back') }]]),
      [{ text: 'Отмена', callbackData: callback('cancel') }],
    ],
  };
};

export const renderCancelConfirmation = (
  draft: TemplateWizardDraft,
): OrganizerView => ({
  text: `Отменить ${draft.mode === 'EDIT' ? 'изменение' : 'создание'} шаблона?`,
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Да, отменить',
        callbackData: templateCallback(
          'cancel-confirm',
          templateDraftControlId(draft),
        ),
      },
    ],
    [
      {
        text: 'Нет',
        callbackData: templateCallback('resume', templateDraftControlId(draft)),
      },
    ],
  ],
});

export const templateCallback = (action: string, opaqueId?: string): string => {
  const value = `tw:v1:${action}${opaqueId === undefined ? '' : `:${opaqueId}`}`;
  if (Buffer.byteLength(value, 'utf8') >= 64)
    throw new Error('Telegram callback payload must be under 64 bytes');
  if (!isTemplateCallbackShape(action, opaqueId))
    throw new Error('Invalid template callback');
  return value;
};

const templateActionsWithoutOpaque = new Set(['create', 'active', 'archived']);
const templateActionsWithOpaque = new Set([
  'next',
  'next-archived',
  'open',
  'edit',
  'copy',
  'game',
  'archive',
  'archive-confirm',
  'restore',
  'continue',
  'restart',
  'back',
  'cancel',
  'resume',
  'cancel-confirm',
  'priority-yes',
  'priority-no',
  'round-exact',
  'round-1',
  'round-10',
  'round-50',
  'save',
]);

export const isTemplateCallbackShape = (
  action: string,
  opaqueId?: string,
): boolean =>
  (templateActionsWithoutOpaque.has(action) && opaqueId === undefined) ||
  (templateActionsWithOpaque.has(action) &&
    opaqueId !== undefined &&
    opaqueId.length > 0 &&
    !opaqueId.includes(':'));

export const compactUuid = (value: string): string => {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid UUID');
  return Buffer.from(hex, 'hex').toString('base64url');
};

export const expandUuid = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value))
    throw new Error('Invalid compact UUID');
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (
    hex.length !== 32 ||
    Buffer.from(hex, 'hex').toString('base64url') !== value
  )
    throw new Error('Invalid compact UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const choiceRows = (
  step: TemplateWizardStep,
  callback: (action: string) => string,
): OrganizerView['keyboard'] => {
  if (step === 'MEMBER_PRIORITY')
    return [
      [
        { text: 'Да', callbackData: callback('priority-yes') },
        { text: 'Нет', callbackData: callback('priority-no') },
      ],
    ];
  if (step === 'ROUNDING')
    return [
      [{ text: 'Точно до копеек', callbackData: callback('round-exact') }],
      [{ text: 'До 1 ₽ вверх', callbackData: callback('round-1') }],
      [{ text: 'До 10 ₽ вверх', callbackData: callback('round-10') }],
      [{ text: 'До 50 ₽ вверх', callbackData: callback('round-50') }],
    ];
  return [];
};

const stepTitle = (step: Exclude<TemplateWizardStep, 'PREVIEW'>): string =>
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
  })[step];

const stepHint = (step: Exclude<TemplateWizardStep, 'PREVIEW'>): string =>
  ({
    NAME: 'Отправьте название шаблона.',
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
  })[step];

const snapshotSummary = (draft: TemplateWizardDraft): string => {
  const snapshot = draft.snapshot;
  const cost = snapshot.defaultTotalCostMinor;
  return [
    `<b>${escapeHtml(snapshot.name ?? '')}</b>`,
    `${escapeHtml(snapshot.venue ?? '')}${snapshot.address ? `, ${escapeHtml(snapshot.address)}` : ''}`,
    `${snapshot.startsAtLocalTime ?? ''} · ${snapshot.durationMinutes ?? ''} мин · ${snapshot.capacity ?? ''} мест`,
    `Стоимость: ${cost == null ? 'не указана' : `${formatMinor(cost)} ₽`}`,
  ].join('\n');
};

const formatMinor = (minor: bigint): string =>
  `${minor / 100n},${(minor % 100n).toString().padStart(2, '0')}`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
