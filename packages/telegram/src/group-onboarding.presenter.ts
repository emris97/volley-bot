import type { GroupId } from '@volley/domain';
import {
  encodeActionCallback,
  encodeAnswerCallback,
  nextWizardCode,
  type CompleteWizardProgress,
  type WizardAnswer,
  type WizardCode,
  type WizardProgress,
} from './group-onboarding.model.js';

export interface OnboardingView {
  text: string;
  parseMode?: 'HTML';
  keyboard: readonly (readonly {
    text: string;
    callbackData: string;
  }[])[];
}

export interface ConfiguredGroupSettings {
  timeZone: string;
  memberPriorityEnabled: boolean;
  tentativePromptMinutesBefore: number;
  tentativeResponseMinutes: number;
  reminderMinutesBefore: number;
  currency: 'RUB';
  roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
  pinGameMessages: boolean;
}

export type StartErrorReason =
  | 'BARE_START'
  | 'INVALID_LINK'
  | 'EXPIRED_LINK'
  | 'FOREIGN_LINK'
  | 'ADMIN_REQUIRED';

const stepOptions: Readonly<
  Record<WizardCode, readonly { text: string; answer: WizardAnswer }[]>
> = {
  tz: [
    {
      text: 'Астрахань (UTC+4)',
      answer: { code: 'tz', value: 'Europe/Astrakhan' },
    },
  ],
  mp: [
    {
      text: 'Участники группы выше гостей',
      answer: { code: 'mp', value: true },
    },
    { text: 'В порядке записи', answer: { code: 'mp', value: false } },
  ],
  tp: [
    { text: 'За 24 часа', answer: { code: 'tp', value: 1440 } },
    { text: 'За 12 часов', answer: { code: 'tp', value: 720 } },
    { text: 'За 6 часов', answer: { code: 'tp', value: 360 } },
  ],
  tr: [
    { text: '30 минут', answer: { code: 'tr', value: 30 } },
    { text: '1 час', answer: { code: 'tr', value: 60 } },
    { text: '2 часа', answer: { code: 'tr', value: 120 } },
  ],
  rm: [
    { text: 'За 30 минут', answer: { code: 'rm', value: 30 } },
    { text: 'За 1 час', answer: { code: 'rm', value: 60 } },
    { text: 'За 2 часа', answer: { code: 'rm', value: 120 } },
  ],
  ro: [
    { text: 'Точно до копеек', answer: { code: 'ro', value: 'EXACT' } },
    { text: 'Вверх до 1 ₽', answer: { code: 'ro', value: 'UP_1' } },
    { text: 'Вверх до 10 ₽', answer: { code: 'ro', value: 'UP_10' } },
    { text: 'Вверх до 50 ₽', answer: { code: 'ro', value: 'UP_50' } },
  ],
  pin: [
    { text: 'Да', answer: { code: 'pin', value: true } },
    { text: 'Нет', answer: { code: 'pin', value: false } },
  ],
};

const questions: Readonly<Record<WizardCode, string>> = {
  tz: 'Выберите часовой пояс группы.',
  mp: 'Кому отдавать приоритет при регистрации?',
  tp: 'Когда попросить подтверждение у участников со статусом «Не уверен»?',
  tr: 'Сколько времени дать на подтверждение?',
  rm: 'Когда напомнить о начале игры?',
  ro: 'Как округлять сумму к оплате?',
  pin: 'Закреплять сообщения об играх в группе?',
};

export const renderWizardView = (
  groupId: GroupId,
  progress: WizardProgress,
): OnboardingView => {
  const code = nextWizardCode(progress);
  if (code === undefined) {
    return {
      text: ['<b>Проверьте настройки</b>', '', ...summaryLines(toSettings(progress))].join(
        '\n',
      ),
      parseMode: 'HTML',
      keyboard: [
        [
          {
            text: '✅ Сохранить настройки',
            callbackData: encodeActionCallback(groupId, 'SAVE'),
          },
        ],
        [
          {
            text: '🔄 Начать заново',
            callbackData: encodeActionCallback(groupId, 'RESET'),
          },
        ],
      ],
    };
  }
  const step = stepIndex(code) + 1;
  return {
    text: `<b>Настройка группы</b>\n\nШаг ${step} из 7\n${questions[code]}`,
    parseMode: 'HTML',
    keyboard: stepOptions[code].map(({ text, answer }) => [
      { text, callbackData: encodeAnswerCallback(groupId, answer) },
    ]),
  };
};

export const renderConfiguredSummary = (
  settings: ConfiguredGroupSettings,
): OnboardingView => ({
  text: ['<b>Группа уже настроена</b>', '', ...summaryLines(settings)].join(
    '\n',
  ),
  parseMode: 'HTML',
  keyboard: [],
});

export const renderStartError = (reason: StartErrorReason): OnboardingView => ({
  text: {
    BARE_START:
      'Чтобы настроить группу, откройте ссылку, которую бот отправил в группу.',
    INVALID_LINK: 'Ссылка недействительна. Получите новую ссылку в группе.',
    EXPIRED_LINK: 'Срок действия ссылки истёк. Получите новую ссылку в группе.',
    FOREIGN_LINK: 'Эта ссылка предназначена для другого администратора.',
    ADMIN_REQUIRED: 'Для настройки нужны права администратора группы.',
  }[reason],
  keyboard: [],
});

const stepIndex = (code: WizardCode): number =>
  ({ tz: 0, mp: 1, tp: 2, tr: 3, rm: 4, ro: 5, pin: 6 })[code];

const toSettings = (
  progress: WizardProgress,
): ConfiguredGroupSettings => {
  const complete = progress as CompleteWizardProgress;
  return {
    timeZone: complete.tz,
    memberPriorityEnabled: complete.mp,
    tentativePromptMinutesBefore: complete.tp,
    tentativeResponseMinutes: complete.tr,
    reminderMinutesBefore: complete.rm,
    currency: 'RUB',
    roundingMode: complete.ro,
    pinGameMessages: complete.pin,
  };
};

const summaryLines = (settings: ConfiguredGroupSettings): string[] => [
  `Часовой пояс: ${timeZoneLabel(settings.timeZone)}`,
  `Приоритет регистрации: ${settings.memberPriorityEnabled ? 'участники группы выше гостей' : 'в порядке записи'}`,
  `Запрос подтверждения: ${beforeLabel(settings.tentativePromptMinutesBefore)}`,
  `Окно ответа: ${durationLabel(settings.tentativeResponseMinutes)}`,
  `Напоминание об игре: ${beforeLabel(settings.reminderMinutesBefore)}`,
  `Округление: ${roundingLabel(settings.roundingMode)}`,
  `Закреплять сообщения: ${settings.pinGameMessages ? 'да' : 'нет'}`,
  `Валюта: ${settings.currency}`,
];

const timeZoneLabel = (value: string): string =>
  value === 'Europe/Astrakhan' ? 'Астрахань (UTC+4)' : escapeHtml(value);

const beforeLabel = (minutes: number): string =>
  ({ 30: 'за 30 минут', 60: 'за 1 час', 120: 'за 2 часа', 360: 'за 6 часов', 720: 'за 12 часов', 1440: 'за 24 часа' })[
    minutes
  ] ?? `за ${minutes} мин.`;

const durationLabel = (minutes: number): string =>
  ({ 30: '30 минут', 60: '1 час', 120: '2 часа' })[minutes] ??
  `${minutes} мин.`;

const roundingLabel = (
  value: ConfiguredGroupSettings['roundingMode'],
): string =>
  ({ EXACT: 'Точно до копеек', UP_1: 'Вверх до 1 ₽', UP_10: 'Вверх до 10 ₽', UP_50: 'Вверх до 50 ₽' })[
    value
  ];

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
