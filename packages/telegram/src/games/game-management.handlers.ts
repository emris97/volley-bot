import type {
  ChangeGameStateCommand,
  DeleteDraftGameCommand,
  GamePage,
  ListGamesCommand,
  OrganizerContext,
  UpdateGameCommand,
} from '@volley/application';
import type { Game, GameId, TelegramId } from '@volley/domain';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import {
  renderGameList,
  type VisibleGameListBucket,
} from './game-list.presenter.js';

interface GameStateChanger {
  execute(command: ChangeGameStateCommand): Promise<Game>;
}

interface GameUpdater {
  execute(command: UpdateGameCommand): Promise<unknown>;
}

interface DraftGameDeleter {
  execute(command: DeleteDraftGameCommand): Promise<void>;
}

interface GameLister {
  execute(command: ListGamesCommand): Promise<GamePage>;
}

interface GameOrganizerContext {
  require(telegramUserId: TelegramId): Promise<OrganizerContext>;
}

export class GameManagementHandlers {
  public constructor(
    private readonly changeGameState: GameStateChanger,
    private readonly updateGame: GameUpdater,
    private readonly deleteDraftGame?: DraftGameDeleter,
    private readonly gameLister?: GameLister,
    private readonly organizerContext?: GameOrganizerContext,
  ) {}

  public async changeState(command: ChangeGameStateCommand): Promise<Game> {
    return this.changeGameState.execute(command);
  }

  public async update(command: UpdateGameCommand): Promise<unknown> {
    return this.updateGame.execute(command);
  }

  public async deleteDraft(command: DeleteDraftGameCommand): Promise<void> {
    if (this.deleteDraftGame === undefined) {
      throw new Error('Draft deletion is not configured');
    }
    await this.deleteDraftGame.execute(command);
  }

  public async openGames(
    telegramUserId: TelegramId,
    bucket: VisibleGameListBucket | 'PAST' = 'UPCOMING',
    cursor: GameId | null = null,
  ): Promise<OrganizerView> {
    if (this.gameLister === undefined || this.organizerContext === undefined) {
      throw new Error('Game lists are not configured');
    }
    const actor = await this.organizerContext.require(telegramUserId);
    const normalizedBucket: VisibleGameListBucket =
      bucket === 'PAST' ? 'HISTORY' : bucket;
    const page = await this.gameLister.execute({
      groupId: actor.groupId,
      actorUserId: actor.userId,
      bucket: normalizedBucket,
      limit: 8,
      cursor,
    });
    return renderGameList({
      bucket: normalizedBucket,
      items: page.items,
      nextCursor: page.nextCursor,
      timeZone: actor.timeZone,
    });
  }

  public async listGames(command: ListGamesCommand): Promise<GamePage> {
    if (this.gameLister === undefined) {
      throw new Error('Game lists are not configured');
    }
    return this.gameLister.execute(command);
  }
}
