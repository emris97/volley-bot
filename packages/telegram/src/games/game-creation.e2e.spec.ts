import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asUserId,
} from '@volley/domain';
import { expect, it } from 'vitest';
import {
  GameCreationHandlers,
  type GameCreationDraft,
} from './game-creation.handlers.js';

it('persists template selection and requires preview before publish', async () => {
  let stored: GameCreationDraft | null = null;
  const created: unknown[] = [];
  const repository = {
    load: async () => stored,
    save: async (draft: GameCreationDraft) => {
      stored = structuredClone(draft);
    },
    clear: async () => {
      stored = null;
    },
  };
  const create = {
    execute: async (command: unknown) => {
      created.push(command);
      return { id: asGameId('game-1'), state: 'DRAFT' as const };
    },
  };
  const input = {
    groupId: asGroupId('group-1'),
    actorUserId: asUserId('admin-1'),
  };
  const firstProcess = new GameCreationHandlers(repository, create);
  await firstProcess.start(input);
  await firstProcess.selectTemplate({
    ...input,
    templateId: asGameTemplateId('template-1'),
  });
  await firstProcess.setStartsAt({
    ...input,
    startsAt: new Date('2026-09-12T16:00:00.000Z'),
  });
  await expect(firstProcess.publish(input)).rejects.toThrow(/preview/i);

  const preview = await firstProcess.preview(input);
  expect(preview).toContain('template-1');

  const restartedProcess = new GameCreationHandlers(repository, create);
  await restartedProcess.publish(input);
  expect(created).toEqual([
    expect.objectContaining({
      groupId: input.groupId,
      actorUserId: input.actorUserId,
      templateId: asGameTemplateId('template-1'),
      startsAt: new Date('2026-09-12T16:00:00.000Z'),
    }),
  ]);
  expect(stored).toBeNull();
});
