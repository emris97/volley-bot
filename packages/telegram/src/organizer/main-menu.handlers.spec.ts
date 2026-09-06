import { describe, expect, it, vi } from 'vitest';
import { OrganizerGroupSelectionRequiredError } from '@volley/application';
import { asGroupId, asTelegramId } from '@volley/domain';
import { OrganizerMenuHandlers } from './main-menu.handlers.js';

const telegramUserId = asTelegramId('42');
const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');

const organizerGroup = (selected = true) => ({
  groupId,
  telegramChatId: asTelegramId('-1001'),
  title: 'Волейбол',
  timeZone: 'Europe/Astrakhan',
  selected,
});

describe('OrganizerMenuHandlers', () => {
  it('renders the private home from currently verified organizer groups', async () => {
    const context = {
      list: vi.fn().mockResolvedValue([organizerGroup()]),
      select: vi.fn(),
    };
    const handlers = new OrganizerMenuHandlers(context, sections());

    await expect(handlers.openHome(telegramUserId)).resolves.toMatchObject({
      text: expect.stringContaining('Волейбол'),
    });
    expect(context.list).toHaveBeenCalledWith(telegramUserId);
  });

  it('persists a selected verified group before rendering home again', async () => {
    const context = {
      list: vi.fn().mockResolvedValue([organizerGroup()]),
      select: vi.fn().mockResolvedValue(undefined),
    };
    const handlers = new OrganizerMenuHandlers(context, sections());

    await handlers.selectGroup(telegramUserId, groupId);

    expect(context.select).toHaveBeenCalledWith(telegramUserId, groupId);
    expect(context.list).toHaveBeenCalledWith(telegramUserId);
  });

  it('delegates games navigation without coupling it to start dispatch', async () => {
    const sectionHandlers = sections();
    const handlers = new OrganizerMenuHandlers(
      { list: vi.fn(), select: vi.fn() },
      sectionHandlers,
    );

    await handlers.openGames(telegramUserId, 'UPCOMING');

    expect(sectionHandlers.openGames).toHaveBeenCalledWith(
      telegramUserId,
      'UPCOMING',
    );
  });

  it.each([
    [
      'games',
      (handlers: OrganizerMenuHandlers) => handlers.openGames(telegramUserId),
    ],
    [
      'new game',
      (handlers: OrganizerMenuHandlers) => handlers.openNewGame(telegramUserId),
    ],
    [
      'templates',
      (handlers: OrganizerMenuHandlers) =>
        handlers.openTemplates(telegramUserId),
    ],
    [
      'settings',
      (handlers: OrganizerMenuHandlers) =>
        handlers.openSettings(telegramUserId),
    ],
  ])(
    'renders the group picker for %s when multiple live groups have no selection',
    async (_name, open) => {
      const candidates = [
        organizerGroup(false),
        {
          ...organizerGroup(false),
          groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424622'),
          title: 'Пляжный волейбол',
        },
      ];
      const context = {
        list: vi.fn().mockResolvedValue(candidates),
        select: vi.fn(),
      };
      const sectionHandlers = sections();
      for (const section of [
        sectionHandlers.openGames,
        sectionHandlers.openNewGame,
        sectionHandlers.openTemplates,
        sectionHandlers.openSettings,
      ]) {
        section.mockRejectedValue(new OrganizerGroupSelectionRequiredError());
      }
      const handlers = new OrganizerMenuHandlers(context, sectionHandlers);

      await expect(open(handlers)).resolves.toMatchObject({
        text: expect.stringContaining('Выберите группу'),
      });
      expect(context.list).toHaveBeenCalledWith(telegramUserId);
    },
  );

  it('accepts only versioned group-selection callbacks', async () => {
    const context = {
      list: vi.fn().mockResolvedValue([organizerGroup()]),
      select: vi.fn().mockResolvedValue(undefined),
    };
    const handlers = new OrganizerMenuHandlers(context, sections());

    await expect(
      handlers.handleCallback(
        telegramUserId,
        'om:group:018f6ba0-62d2-7bd1-8f13-12e0c8424611',
      ),
    ).resolves.toBeNull();
    await expect(
      handlers.handleCallback(
        telegramUserId,
        `om:v1:group:${String(groupId).toUpperCase()}`,
      ),
    ).resolves.toBeNull();
    await expect(
      handlers.handleCallback(telegramUserId, `om:v1:group:${groupId}:extra`),
    ).resolves.toBeNull();
    await handlers.handleCallback(
      telegramUserId,
      'om:v1:group:018f6ba0-62d2-7bd1-8f13-12e0c8424611',
    );

    expect(context.select).toHaveBeenCalledOnce();
    expect(context.select).toHaveBeenCalledWith(telegramUserId, groupId);
  });
});

const sections = () => ({
  openGames: vi.fn().mockResolvedValue({
    text: 'games',
    parseMode: 'HTML' as const,
    keyboard: [],
  }),
  openNewGame: vi.fn(),
  openTemplates: vi.fn(),
  openSettings: vi.fn(),
  openHelp: vi.fn(),
});
