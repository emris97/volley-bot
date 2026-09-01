import type {
  ChangeGameStateCommand,
  UpdateGameCommand,
} from '@volley/application';

interface GameStateChanger {
  execute(command: ChangeGameStateCommand): Promise<unknown>;
}

interface GameUpdater {
  execute(command: UpdateGameCommand): Promise<unknown>;
}

export class GameManagementHandlers {
  public constructor(
    private readonly changeGameState: GameStateChanger,
    private readonly updateGame: GameUpdater,
  ) {}

  public async changeState(command: ChangeGameStateCommand): Promise<unknown> {
    return this.changeGameState.execute(command);
  }

  public async update(command: UpdateGameCommand): Promise<unknown> {
    return this.updateGame.execute(command);
  }
}
