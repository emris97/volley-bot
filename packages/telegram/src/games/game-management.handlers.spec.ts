import {
  asGameId,
  asGroupId,
  asTelegramId,
  asUserId,
  type Game,
} from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { GameManagementHandlers } from './game-management.handlers.js';

describe('GameManagementHandlers', () => {
  it('delegates privileged state changes with their expected revision', async () => {
    const calls: unknown[] = [];
    const handlers = new GameManagementHandlers(
      {
        execute: async (command) => {
          calls.push(command);
          return game({ state: 'CLOSED' });
        },
      },
      {
        execute: async () => ({
          game: game({ state: 'OPEN' }),
          rosterCount: 0,
          waitlistCount: 0,
          materialFields: [],
        }),
      },
    );
    const command = {
      groupId: asGroupId('group'),
      gameId: asGameId('game'),
      actorUserId: asUserId('organizer'),
      expectedRevision: 7,
      targetState: 'CLOSED' as const,
    };

    await handlers.changeState(command);

    expect(calls).toEqual([command]);
  });

  it('delegates physical draft deletion', async () => {
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const handlers = handlersWith({ deleteDraft: { execute: deleteDraft } });
    const command = {
      groupId: asGroupId('group'),
      gameId: asGameId('game'),
      actorUserId: asUserId('organizer'),
      expectedRevision: 3,
    };

    await handlers.deleteDraft(command);

    expect(deleteDraft).toHaveBeenCalledWith(command);
  });

  it('delegates revision-bound edits and returns the complete UpdateGame result', async () => {
    const updated = {
      game: game({ venue: 'Новая арена', revision: 5 }),
      rosterCount: 10,
      waitlistCount: 2,
      materialFields: ['venue'] as const,
    };
    const execute = vi.fn().mockResolvedValue(updated);
    const handlers = new GameManagementHandlers(
      { execute: vi.fn() },
      {
        execute,
      },
    );
    const command = {
      groupId: asGroupId('group'),
      gameId: asGameId('game'),
      actorUserId: asUserId('organizer'),
      expectedRevision: 4,
      changes: { venue: 'Новая арена' },
    };

    await expect(handlers.update(command)).resolves.toEqual(updated);
    expect(execute).toHaveBeenCalledWith(command);
  });

  it('live-resolves the selected group and requests exactly eight games', async () => {
    const groupId = asGroupId('20000000-0000-4000-8000-000000000001');
    const userId = asUserId('30000000-0000-4000-8000-000000000001');
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const requireOrganizer = vi.fn().mockResolvedValue({
      groupId,
      userId,
      telegramChatId: asTelegramId('-1001'),
      title: 'Group',
      timeZone: 'Europe/Astrakhan',
    });
    const handlers = handlersWith({
      listGames: { execute: list },
      organizerContext: { require: requireOrganizer },
    });

    const view = await handlers.openGames(asTelegramId('42'), 'UPCOMING');

    expect(requireOrganizer).toHaveBeenCalledWith(asTelegramId('42'));
    expect(list).toHaveBeenCalledWith({
      groupId,
      actorUserId: userId,
      bucket: 'UPCOMING',
      limit: 8,
      cursor: null,
    });
    expect(view.text).toContain('Предстоящие игры');
  });
});

const handlersWith = (overrides: {
  deleteDraft?: { execute: (...args: never[]) => Promise<void> };
  listGames?: { execute: (...args: never[]) => Promise<never> };
  organizerContext?: { require: (...args: never[]) => Promise<never> };
}) =>
  new GameManagementHandlers(
    { execute: vi.fn() },
    { execute: vi.fn() },
    overrides.deleteDraft,
    overrides.listGames,
    overrides.organizerContext,
  );

const game = (overrides: Partial<Game> = {}): Game => ({
  id: asGameId('10000000-0000-4000-8000-000000000001'),
  groupId: asGroupId('20000000-0000-4000-8000-000000000001'),
  sourceTemplateId: null,
  name: 'Игра',
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
  revision: 0,
  scheduleRevision: 0,
  canonicalTelegramMessageId: null,
  ...overrides,
});
