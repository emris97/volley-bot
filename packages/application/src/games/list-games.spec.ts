import { asGameId, asGroupId, asUserId } from '@volley/domain';
import { expect, it, vi } from 'vitest';
import { ListGames } from './list-games.js';

it('authorizes and requests exactly eight games with the supplied cursor', async () => {
  const groupId = asGroupId('20000000-0000-4000-8000-000000000001');
  const actorUserId = asUserId('30000000-0000-4000-8000-000000000001');
  const cursor = asGameId('10000000-0000-4000-8000-000000000001');
  const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const useCase = new ListGames(
    { requireOrganizer: vi.fn().mockResolvedValue(undefined) },
    { list },
  );

  await expect(
    useCase.execute({
      groupId,
      actorUserId,
      bucket: 'UPCOMING',
      limit: 8,
      cursor,
    }),
  ).resolves.toEqual({ items: [], nextCursor: null });
  expect(list).toHaveBeenCalledWith(groupId, {
    bucket: 'UPCOMING',
    limit: 8,
    cursor,
  });
});
