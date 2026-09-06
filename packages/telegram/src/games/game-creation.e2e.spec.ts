import type {
  GameCreationDraft,
  PublishGameCommand,
} from '@volley/application';
import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asUserId,
  createGameFromTemplate,
  type GameTemplateSnapshot,
} from '@volley/domain';
import { expect, it } from 'vitest';
import { GameCreationHandlers } from './game-creation.handlers.js';

const settings: GameTemplateSnapshot = {
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAtLocalTime: '20:00',
  durationMinutes: 120,
  capacity: 12,
  registrationOpensMinutesBefore: 10_080,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
};

it('copies settings, invalidates previews, and keeps a published draft repeatable', async () => {
  let stored: GameCreationDraft | null = null;
  const commands: PublishGameCommand[] = [];
  const gameId = asGameId('40000000-0000-4000-8000-000000000001');
  const repository = {
    load: async () => structuredClone(stored),
    replaceForNewFlow: async (
      draft: GameCreationDraft,
      expected?: {
        draftId: string;
        step: GameCreationDraft['step'];
        viewRevision: number;
      } | null,
    ) => {
      if (
        (expected === null && stored !== null) ||
        (expected !== null &&
          expected !== undefined &&
          (stored === null ||
            stored.draftId !== expected.draftId ||
            stored.step !== expected.step ||
            (stored.viewRevision ?? 0) !== expected.viewRevision))
      ) {
        return 'STALE' as const;
      }
      stored = structuredClone(draft);
      return 'SAVED' as const;
    },
    compareAndSet: async (draft: GameCreationDraft) => {
      if (
        stored === null ||
        stored.draftId !== draft.draftId ||
        stored.publishedGameId !== undefined
      ) {
        return 'STALE' as const;
      }
      stored = structuredClone(draft);
      return 'SAVED' as const;
    },
    clear: async () => {
      stored = null;
    },
  };
  const publisher = {
    execute: async (command: PublishGameCommand) => {
      commands.push(command);
      const created = stored?.publishedGameId === undefined;
      stored = {
        ...stored!,
        step: 'PUBLISHED',
        publishedGameId: gameId,
      };
      return {
        game: {
          ...createGameFromTemplate(
            settings,
            new Date('2026-09-12T16:00:00.000Z'),
            'Europe/Astrakhan',
          ),
          id: gameId,
          groupId: command.groupId,
          sourceTemplateId: asGameTemplateId(
            '30000000-0000-4000-8000-000000000001',
          ),
          state: 'SCHEDULED' as const,
        },
        created,
      };
    },
  };
  const input = {
    groupId: asGroupId('10000000-0000-4000-8000-000000000001'),
    actorUserId: asUserId('20000000-0000-4000-8000-000000000001'),
  };
  const now = new Date('2026-09-05T15:00:00.000Z');
  const firstProcess = new GameCreationHandlers(
    repository,
    publisher,
    () => now,
  );

  await firstProcess.start(input);
  const firstDraftId = stored!.draftId;
  const selectedSettings = { ...settings };
  await firstProcess.selectTemplate({
    ...input,
    templateId: asGameTemplateId('30000000-0000-4000-8000-000000000001'),
    snapshot: selectedSettings,
  });
  selectedSettings.capacity = 99;
  expect(stored).toMatchObject({
    version: 1,
    draftId: firstDraftId,
    step: 'DATE',
    snapshot: { capacity: 12 },
    previewed: false,
  });

  await firstProcess.setStartsAt({
    ...input,
    startsAt: new Date('2026-09-12T16:00:00.000Z'),
  });
  await expect(firstProcess.publish(input)).rejects.toThrow(/preview/i);

  const preview = await firstProcess.preview(input);
  expect(preview).toContain('Место: Arena');
  expect(stored).toMatchObject({ step: 'PREVIEW', previewed: true });

  await firstProcess.customize({ ...input, overrides: { capacity: 18 } });
  expect(stored).toMatchObject({
    step: 'CUSTOMIZE',
    snapshot: { capacity: 18 },
    previewed: false,
  });
  await expect(firstProcess.publish(input)).rejects.toThrow(/preview/i);
  await firstProcess.preview(input);

  const restartedProcess = new GameCreationHandlers(
    repository,
    publisher,
    () => now,
  );
  const first = await restartedProcess.publish(input);
  const second = await restartedProcess.publish(input);

  expect(first).toMatchObject({ game: { id: gameId }, created: true });
  expect(second).toMatchObject({ game: { id: gameId }, created: false });
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual({
    ...input,
    draftId: firstDraftId,
    expectedStep: 'PREVIEW',
    expectedViewRevision: 5,
    now,
  });
  expect(commands[1]).toEqual(commands[0]);
  expect(stored).toMatchObject({
    draftId: firstDraftId,
    step: 'PUBLISHED',
    publishedGameId: gameId,
  });

  await restartedProcess.start(input);
  expect(stored).toMatchObject({
    version: 1,
    step: 'TEMPLATE',
    previewed: false,
  });
  expect(stored!.draftId).not.toBe(firstDraftId);
});

it('rejects a typed stale mutation without replacing the published draft', async () => {
  const gameId = asGameId('40000000-0000-4000-8000-000000000002');
  const staleDraft: GameCreationDraft = {
    version: 1,
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    groupId: asGroupId('10000000-0000-4000-8000-000000000002'),
    actorUserId: asUserId('20000000-0000-4000-8000-000000000002'),
    step: 'PREVIEW',
    snapshot: settings,
    startsAtIso: '2026-09-12T16:00:00.000Z',
    previewed: true,
  };
  let authoritative: GameCreationDraft = {
    ...staleDraft,
    step: 'PUBLISHED',
    publishedGameId: gameId,
  };
  const repository = {
    load: async () => structuredClone(staleDraft),
    replaceForNewFlow: async (draft: GameCreationDraft) => {
      authoritative = structuredClone(draft);
      return 'SAVED' as const;
    },
    compareAndSet: async () => 'STALE' as const,
    clear: async () => undefined,
  };
  const handlers = new GameCreationHandlers(repository, {
    execute: async () => {
      throw new Error('unused');
    },
  });

  await expect(
    handlers.customize({
      groupId: staleDraft.groupId,
      actorUserId: staleDraft.actorUserId,
      overrides: { capacity: 99 },
    }),
  ).rejects.toThrow(/stale/i);
  expect(authoritative).toMatchObject({
    step: 'PUBLISHED',
    snapshot: { capacity: 12 },
    publishedGameId: gameId,
  });
});
