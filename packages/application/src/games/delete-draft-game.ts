import type { GameId, GroupId, UserId } from '@volley/domain';
import { GameRevisionConflictError } from './game-edit-policy.js';
import type { DraftGameRepository, GameAuthorization } from './ports.js';

export interface DeleteDraftGameCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  expectedRevision: number;
}

export class DeleteDraftGame {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly games: DraftGameRepository,
  ) {}

  public async execute(command: DeleteDraftGameCommand): Promise<void> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const result = await this.games.deleteDraft(command);
    if (result === 'DELETED') return;
    if (result === 'STALE') throw new GameRevisionConflictError();
    if (result === 'NOT_FOUND') throw new Error('Игра не найдена.');
    throw new Error(
      'Можно удалить только неопубликованный черновик без регистраций.',
    );
  }
}
