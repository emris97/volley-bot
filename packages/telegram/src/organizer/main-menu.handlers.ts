import type { OrganizerGroupCandidate } from '@volley/application';
import { asGroupId, type GroupId, type TelegramId } from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { toTelegramId } from '../group-onboarding.handlers.js';
import {
  renderOrganizerGroupPicker,
  renderOrganizerHome,
  type OrganizerView,
} from './main-menu.presenter.js';

type GameListKind = 'UPCOMING' | 'PAST';

export interface OrganizerContextResolver {
  list(telegramUserId: TelegramId): Promise<readonly OrganizerGroupCandidate[]>;
  select(telegramUserId: TelegramId, groupId: GroupId): Promise<unknown>;
}

export interface OrganizerSectionHandlers {
  openGames(
    telegramUserId: TelegramId,
    kind: GameListKind,
  ): Promise<OrganizerView>;
  openNewGame(telegramUserId: TelegramId): Promise<OrganizerView>;
  openTemplates(telegramUserId: TelegramId): Promise<OrganizerView>;
  openSettings(telegramUserId: TelegramId): Promise<OrganizerView>;
  openHelp(telegramUserId: TelegramId): Promise<OrganizerView>;
}

export class OrganizerMenuHandlers {
  public constructor(
    private readonly organizerContext: OrganizerContextResolver,
    private readonly sections: OrganizerSectionHandlers,
  ) {}

  public async openHome(telegramUserId: TelegramId): Promise<OrganizerView> {
    return renderOrganizerHome(
      await this.organizerContext.list(telegramUserId),
    );
  }

  public async selectGroup(
    telegramUserId: TelegramId,
    groupId: GroupId,
  ): Promise<OrganizerView> {
    await this.organizerContext.select(telegramUserId, groupId);
    return this.openHome(telegramUserId);
  }

  public openGames(
    telegramUserId: TelegramId,
    kind: GameListKind = 'UPCOMING',
  ): Promise<OrganizerView> {
    return this.sections.openGames(telegramUserId, kind);
  }

  public openNewGame(telegramUserId: TelegramId): Promise<OrganizerView> {
    return this.sections.openNewGame(telegramUserId);
  }

  public openTemplates(telegramUserId: TelegramId): Promise<OrganizerView> {
    return this.sections.openTemplates(telegramUserId);
  }

  public openSettings(telegramUserId: TelegramId): Promise<OrganizerView> {
    return this.sections.openSettings(telegramUserId);
  }

  public openHelp(telegramUserId: TelegramId): Promise<OrganizerView> {
    return this.sections.openHelp(telegramUserId);
  }

  public async openGroupPicker(
    telegramUserId: TelegramId,
  ): Promise<OrganizerView> {
    return renderOrganizerGroupPicker(
      await this.organizerContext.list(telegramUserId),
    );
  }

  public async handleCallback(
    telegramUserId: TelegramId,
    data: string,
  ): Promise<OrganizerView | null> {
    if (data === 'om:home') return this.openHome(telegramUserId);
    if (data === 'om:groups') return this.openGroupPicker(telegramUserId);
    if (data === 'om:new') return this.openNewGame(telegramUserId);
    if (data === 'om:games:upcoming')
      return this.openGames(telegramUserId, 'UPCOMING');
    if (data === 'om:games:past') return this.openGames(telegramUserId, 'PAST');
    if (data === 'om:templates') return this.openTemplates(telegramUserId);
    if (data === 'om:settings') return this.openSettings(telegramUserId);
    if (data === 'om:help') return this.openHelp(telegramUserId);

    const groupId = parseGroupSelection(data);
    return groupId === undefined
      ? null
      : this.selectGroup(telegramUserId, groupId);
  }
}

export const registerOrganizerMenuHandlers = (
  bot: Bot<Context>,
  handlers: OrganizerMenuHandlers,
): Bot<Context> => {
  const command =
    (open: (telegramUserId: TelegramId) => Promise<OrganizerView>) =>
    async (context: Context): Promise<void> => {
      if (context.from === undefined || context.chat?.type !== 'private')
        return;
      await replyView(context, await open(toTelegramId(context.from.id)));
    };

  bot.command(
    'games',
    command((telegramUserId) => handlers.openGames(telegramUserId)),
  );
  bot.command(
    'newgame',
    command((telegramUserId) => handlers.openNewGame(telegramUserId)),
  );
  bot.command(
    'templates',
    command((telegramUserId) => handlers.openTemplates(telegramUserId)),
  );
  bot.command(
    'settings',
    command((telegramUserId) => handlers.openSettings(telegramUserId)),
  );
  bot.command(
    'help',
    command((telegramUserId) => handlers.openHelp(telegramUserId)),
  );
  bot.callbackQuery(/^om:/, async (context) => {
    if (context.callbackQuery.message?.chat.type !== 'private') {
      await context.answerCallbackQuery();
      return;
    }
    const data = context.callbackQuery.data;
    if (data === undefined) {
      await context.answerCallbackQuery();
      return;
    }
    const view = await handlers.handleCallback(
      toTelegramId(context.callbackQuery.from.id),
      data,
    );
    if (view !== null) await editView(context, view);
    await context.answerCallbackQuery();
  });
  return bot;
};

const parseGroupSelection = (data: string): GroupId | undefined => {
  const match =
    /^om:group:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(data);
  const groupId = match?.[1];
  return groupId === undefined ? undefined : asGroupId(groupId);
};

const replyView = async (
  context: Context,
  view: OrganizerView,
): Promise<void> => {
  await context.reply(view.text, viewOptions(view));
};

const editView = async (
  context: Context,
  view: OrganizerView,
): Promise<void> => {
  await context.editMessageText(view.text, viewOptions(view));
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
