import {
  asGameTemplateId,
  asGroupId,
  asUserId,
  type Game,
  type GameTemplate,
} from '@volley/domain';
import { describe, expect, it } from 'vitest';
import { CreateGame } from './create-game.js';
import type {
  GameAuthorization,
  GameGroupSettingsRepository,
  GameRepository,
  TemplateRepository,
} from './ports.js';

const groupId = asGroupId('10000000-0000-4000-8000-000000000001');
const actorUserId = asUserId('20000000-0000-4000-8000-000000000001');
const templateId = asGameTemplateId('30000000-0000-4000-8000-000000000001');

const template: GameTemplate = {
  id: templateId,
  groupId,
  name: 'Wednesday volleyball',
  venue: 'Central gym',
  address: null,
  startsAtLocalTime: '19:00',
  durationMinutes: 120,
  capacity: 14,
  registrationOpensMinutesBefore: 10_080,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('CreateGame', () => {
  it('creates a tenant-scoped template snapshot with overrides', async () => {
    const inserted: Game[] = [];
    const authorization: GameAuthorization = {
      requireOrganizer: async () => undefined,
    };
    const templates: TemplateRepository = {
      findById: async (requestedGroupId, requestedTemplateId) =>
        requestedGroupId === groupId && requestedTemplateId === templateId
          ? template
          : null,
      insert: async () => template,
    };
    const games: GameRepository = {
      insert: async (game) => {
        inserted.push(game);
        return game;
      },
      withLockedGame: async () => {
        throw new Error('unused');
      },
    };
    const groups: GameGroupSettingsRepository = {
      findTimeZone: async () => 'Europe/Astrakhan',
    };
    const useCase = new CreateGame(authorization, templates, games, groups);

    const result = await useCase.execute({
      groupId,
      actorUserId,
      templateId,
      startsAt: new Date('2026-09-01T16:00:00.000Z'),
      overrides: { capacity: 18 },
    });

    expect(result.capacity).toBe(18);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      groupId,
      sourceTemplateId: templateId,
      name: 'Wednesday volleyball',
      capacity: 18,
      timeZone: 'Europe/Astrakhan',
    });
  });

  it('rejects a template belonging to another group', async () => {
    const useCase = new CreateGame(
      { requireOrganizer: async () => undefined },
      {
        findById: async () => null,
        insert: async () => template,
      },
      {
        insert: async (game) => game,
        withLockedGame: async () => {
          throw new Error('unused');
        },
      },
      { findTimeZone: async () => 'UTC' },
    );

    await expect(
      useCase.execute({
        groupId,
        actorUserId,
        templateId,
        startsAt: new Date('2026-09-01T16:00:00.000Z'),
        overrides: {},
      }),
    ).rejects.toThrow(/template not found/i);
  });

  it('creates a game from complete scratch settings', async () => {
    const gamesInserted: Game[] = [];
    const useCase = new CreateGame(
      { requireOrganizer: async () => undefined },
      {
        findById: async () => null,
        insert: async () => template,
      },
      {
        insert: async (game) => {
          gamesInserted.push(game);
          return game;
        },
        withLockedGame: async () => {
          throw new Error('unused');
        },
      },
      { findTimeZone: async () => 'Europe/Astrakhan' },
    );

    const result = await useCase.execute({
      groupId,
      actorUserId,
      startsAt: new Date('2026-09-01T16:00:00.000Z'),
      overrides: {
        name: 'One-off game',
        venue: 'Beach court',
        address: null,
        startsAtLocalTime: '20:00',
        durationMinutes: 90,
        capacity: 8,
        registrationOpensMinutesBefore: 1_440,
        registrationClosesMinutesBefore: null,
        tentativePromptMinutesBefore: 240,
        tentativeResponseMinutes: 30,
        reminderMinutesBefore: 60,
        memberPriorityEnabled: false,
        defaultTotalCostMinor: null,
        currency: 'RUB',
        roundingMode: 'EXACT',
      },
    });

    expect(result).toMatchObject({
      groupId,
      sourceTemplateId: null,
      name: 'One-off game',
      capacity: 8,
    });
    expect(gamesInserted).toHaveLength(1);
  });
});
