import { describe, expect, it, vi } from 'vitest';
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
