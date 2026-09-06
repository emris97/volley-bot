import type {
  ConfigureGroupCommand,
  OrganizerContext,
} from '@volley/application';
import type { GroupId, TelegramId } from '@volley/domain';
import type { Bot, Context } from 'grammy';
import {
  configuredGroupSummaryLines,
  type ConfiguredGroupSettings,
} from '../group-onboarding.presenter.js';
import { toTelegramId } from '../group-onboarding.handlers.js';
import type { OrganizerView } from './main-menu.presenter.js';

interface SettingsOrganizerContext {
  require(telegramUserId: TelegramId): Promise<OrganizerContext>;
}

interface SettingsRepository {
  getOnboardingSnapshot(groupId: GroupId): Promise<{
    onboardingState: 'PENDING' | 'CONFIGURING' | 'CONFIGURED';
    settings: ConfiguredGroupSettings;
  } | null>;
}

interface GroupConfigurer {
  execute(command: ConfigureGroupCommand): Promise<boolean>;
}

type SettingCode = 'tz' | 'mp' | 'tp' | 'tr' | 'rm' | 'ro' | 'pin';

const choices: Readonly<
  Record<
    SettingCode,
    readonly { text: string; token: string; value: unknown }[]
  >
> = {
  tz: [{ text: 'Астрахань (UTC+4)', token: 'a', value: 'Europe/Astrakhan' }],
  mp: [
    { text: 'Участники группы выше гостей', token: 'y', value: true },
    { text: 'В порядке записи', token: 'n', value: false },
  ],
  tp: [
    { text: 'За 24 часа', token: '1440', value: 1440 },
    { text: 'За 12 часов', token: '720', value: 720 },
    { text: 'За 6 часов', token: '360', value: 360 },
  ],
  tr: [
    { text: '1 час', token: '60', value: 60 },
    { text: '30 минут', token: '30', value: 30 },
    { text: '2 часа', token: '120', value: 120 },
  ],
  rm: [
    { text: 'За 2 часа', token: '120', value: 120 },
    { text: 'За 30 минут', token: '30', value: 30 },
    { text: 'За 1 час', token: '60', value: 60 },
  ],
  ro: [
    { text: 'Точно до копеек', token: 'e', value: 'EXACT' },
    { text: 'Вверх до 1 ₽', token: '1', value: 'UP_1' },
    { text: 'Вверх до 10 ₽', token: 'a', value: 'UP_10' },
    { text: 'Вверх до 50 ₽', token: 'f', value: 'UP_50' },
  ],
  pin: [
    { text: 'Да', token: 'y', value: true },
    { text: 'Нет', token: 'n', value: false },
  ],
};

const questions: Readonly<Record<SettingCode, string>> = {
  tz: 'Выберите часовой пояс группы.',
  mp: 'Кому отдавать приоритет при регистрации?',
  tp: 'Когда попросить подтверждение у участников со статусом «Не уверен»?',
  tr: 'Сколько времени дать на подтверждение?',
  rm: 'Когда напомнить о начале игры?',
  ro: 'Как округлять сумму к оплате?',
  pin: 'Закреплять сообщения об играх в группе?',
};

const settingLabels: Readonly<Record<SettingCode, string>> = {
  tz: 'Часовой пояс',
  mp: 'Приоритет регистрации',
  tp: 'Запрос подтверждения',
  tr: 'Окно ответа',
  rm: 'Напоминание',
  ro: 'Округление',
  pin: 'Закрепление сообщений',
};

export class GroupSettingsHandlers {
  public constructor(
    private readonly organizerContext: SettingsOrganizerContext,
    private readonly groups: SettingsRepository,
    private readonly configure: GroupConfigurer,
  ) {}

  public async open(telegramUserId: TelegramId): Promise<OrganizerView> {
    const { settings } = await this.current(telegramUserId);
    return renderSummary(settings);
  }

  public async change(telegramUserId: TelegramId): Promise<OrganizerView> {
    await this.current(telegramUserId);
    return renderFieldSelection();
  }

  public async handleCallback(
    telegramUserId: TelegramId,
    data: string,
  ): Promise<OrganizerView> {
    const current = await this.current(telegramUserId);
    if (data === 'gs:v1:open') return renderSummary(current.settings);
    if (data === 'gs:v1:change') return renderFieldSelection();

    const field = /^gs:v1:field:(tz|mp|tp|tr|rm|ro|pin)$/.exec(data)?.[1] as
      SettingCode | undefined;
    if (field !== undefined) return renderQuestion(field);

    const match =
      /^gs:v1:(set|confirm):(tz|mp|tp|tr|rm|ro|pin)\.([A-Za-z0-9]+)$/.exec(
        data,
      );
    if (match === null) return renderSummary(current.settings, staleText);
    const action = match[1];
    const code = match[2] as SettingCode;
    const token = match[3]!;
    const choice = choices[code].find((item) => item.token === token);
    if (choice === undefined) return renderSummary(current.settings, staleText);
    const next = replaceSetting(current.settings, code, choice.value);

    if (action === 'set') return renderConfirmation(next, code, token);

    const saved = await this.configure.execute({
      groupId: current.context.groupId,
      actorTelegramId: telegramUserId,
      ...next,
    });
    return saved
      ? renderSummary(next, 'Настройки сохранены.')
      : renderSummary(current.settings, staleText);
  }

  private async current(telegramUserId: TelegramId): Promise<{
    context: OrganizerContext;
    settings: ConfiguredGroupSettings;
  }> {
    const context = await this.organizerContext.require(telegramUserId);
    const snapshot = await this.groups.getOnboardingSnapshot(context.groupId);
    if (snapshot === null || snapshot.onboardingState !== 'CONFIGURED') {
      throw new Error('Configured organizer group not found');
    }
    return { context, settings: snapshot.settings };
  }
}

export const registerGroupSettingsHandlers = (
  bot: Bot<Context>,
  handlers: GroupSettingsHandlers,
): Bot<Context> => {
  bot.callbackQuery(/^gs:v1:/, async (context) => {
    if (context.callbackQuery.message?.chat.type !== 'private') {
      await context.answerCallbackQuery();
      return;
    }
    try {
      const view = await handlers.handleCallback(
        toTelegramId(context.callbackQuery.from.id),
        context.callbackQuery.data,
      );
      await context.editMessageText(view.text, viewOptions(view));
      await context.answerCallbackQuery();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'OrganizerGroupSelectionRequiredError'
      ) {
        throw error;
      }
      await context.answerCallbackQuery({
        text: 'Настройки доступны только администратору группы.',
        show_alert: true,
      });
    }
  });
  return bot;
};

const renderSummary = (
  settings: ConfiguredGroupSettings,
  notice?: string,
): OrganizerView => ({
  text: [
    '<b>Настройки группы</b>',
    ...(notice === undefined ? [] : ['', notice]),
    '',
    ...settingsSummaryLines(settings),
  ].join('\n'),
  parseMode: 'HTML',
  keyboard: [
    [{ text: 'Изменить настройки', callbackData: 'gs:v1:change' }],
    [{ text: 'Главное меню', callbackData: 'om:v1:home' }],
  ],
});

const renderFieldSelection = (): OrganizerView => ({
  text: '<b>Изменение настроек</b>\n\nЧто изменить?',
  parseMode: 'HTML',
  keyboard: [
    ...(Object.entries(settingLabels) as readonly [SettingCode, string][]).map(
      ([code, text]) => [{ text, callbackData: `gs:v1:field:${code}` }],
    ),
    [{ text: 'Назад', callbackData: 'gs:v1:open' }],
  ],
});

const renderQuestion = (code: SettingCode): OrganizerView => ({
  text: `<b>Изменение настроек</b>\n\n${questions[code]}`,
  parseMode: 'HTML',
  keyboard: [
    ...choices[code].map((choice) => [
      { text: choice.text, callbackData: `gs:v1:set:${code}.${choice.token}` },
    ]),
    [{ text: 'Назад', callbackData: 'gs:v1:change' }],
  ],
});

const renderConfirmation = (
  settings: ConfiguredGroupSettings,
  code: SettingCode,
  token: string,
): OrganizerView => ({
  text: [
    '<b>Подтвердите настройки</b>',
    '',
    ...settingsSummaryLines(settings),
  ].join('\n'),
  parseMode: 'HTML',
  keyboard: [
    [
      {
        text: 'Подтвердить',
        callbackData: `gs:v1:confirm:${code}.${token}`,
      },
    ],
    [{ text: 'Отмена', callbackData: 'gs:v1:open' }],
  ],
});

const replaceSetting = (
  settings: ConfiguredGroupSettings,
  code: SettingCode,
  value: unknown,
): ConfiguredGroupSettings => {
  const field: Readonly<Record<SettingCode, keyof ConfiguredGroupSettings>> = {
    tz: 'timeZone',
    mp: 'memberPriorityEnabled',
    tp: 'tentativePromptMinutesBefore',
    tr: 'tentativeResponseMinutes',
    rm: 'reminderMinutesBefore',
    ro: 'roundingMode',
    pin: 'pinGameMessages',
  };
  return { ...settings, [field[code]]: value } as ConfiguredGroupSettings;
};

const staleText = 'Эта кнопка устарела. Откройте настройки заново.';

const settingsSummaryLines = (settings: ConfiguredGroupSettings): string[] =>
  configuredGroupSummaryLines(settings).map((line, index) =>
    index === 0 ? `${line} — ${settings.timeZone}` : line,
  );

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
