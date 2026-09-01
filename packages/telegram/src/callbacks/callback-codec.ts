import { asGameId, type GameId } from '@volley/domain';

export type GameCallbackAction =
  'GOING' | 'TENTATIVE' | 'WITHDRAW' | 'ADD_GUEST' | 'MANAGE' | 'PUBLISH';

export interface GameCallback {
  version: 1;
  action: GameCallbackAction;
  gameId: GameId;
}

const actionCodes: Record<GameCallbackAction, string> = {
  GOING: 'go',
  TENTATIVE: 'maybe',
  WITHDRAW: 'withdraw',
  ADD_GUEST: 'guest',
  MANAGE: 'manage',
  PUBLISH: 'publish',
};

const actionsByCode = new Map(
  Object.entries(actionCodes).map(([action, code]) => [
    code,
    action as GameCallbackAction,
  ]),
);

export class CallbackCodec {
  public encode(callback: GameCallback): string {
    const encoded = `v${callback.version}:${actionCodes[callback.action]}:${callback.gameId}`;
    if (Buffer.byteLength(encoded, 'utf8') > 64) {
      throw new Error('Telegram callback payload exceeds 64 bytes');
    }
    return encoded;
  }

  public decode(value: string): GameCallback {
    const [version, code, gameId, ...rest] = value.split(':');
    if (version !== 'v1') throw new Error('Unsupported callback version');
    if (rest.length > 0 || code === undefined || gameId === undefined) {
      throw new Error('Invalid game callback');
    }
    const action = actionsByCode.get(code);
    if (
      action === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        gameId,
      )
    ) {
      throw new Error('Invalid game callback');
    }
    return { version: 1, action, gameId: asGameId(gameId) };
  }

  public going(gameId: GameId): string {
    return this.encode({ version: 1, action: 'GOING', gameId });
  }

  public tentative(gameId: GameId): string {
    return this.encode({ version: 1, action: 'TENTATIVE', gameId });
  }

  public withdraw(gameId: GameId): string {
    return this.encode({ version: 1, action: 'WITHDRAW', gameId });
  }

  public addGuest(gameId: GameId): string {
    return this.encode({ version: 1, action: 'ADD_GUEST', gameId });
  }
}
