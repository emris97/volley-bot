import { asGameId, asGroupId, asUserId } from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { DeleteDraftGame } from './delete-draft-game.js';

const command = {
  groupId: asGroupId('20000000-0000-4000-8000-000000000001'),
  gameId: asGameId('10000000-0000-4000-8000-000000000001'),
  actorUserId: asUserId('30000000-0000-4000-8000-000000000001'),
  expectedRevision: 3,
};

describe('DeleteDraftGame', () => {
  it('authorizes and deletes an unreferenced current draft', async () => {
    const deleteDraft = vi.fn().mockResolvedValue('DELETED');
    const useCase = new DeleteDraftGame(
      { requireOrganizer: async () => undefined },
      { deleteDraft },
    );

    await expect(useCase.execute(command)).resolves.toBeUndefined();
    expect(deleteDraft).toHaveBeenCalledWith(command);
  });

  it.each([
    ['STALE', 'Игра уже была изменена. Откройте актуальную версию.'],
    [
      'NOT_DELETABLE',
      'Можно удалить только неопубликованный черновик без регистраций.',
    ],
    ['NOT_FOUND', 'Игра не найдена.'],
  ] as const)('refuses repository result %s', async (result, message) => {
    const useCase = new DeleteDraftGame(
      { requireOrganizer: async () => undefined },
      { deleteDraft: vi.fn().mockResolvedValue(result) },
    );

    await expect(useCase.execute(command)).rejects.toThrow(message);
  });
});
