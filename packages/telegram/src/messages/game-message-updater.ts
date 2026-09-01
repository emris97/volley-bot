import type { GameId, GroupId, TelegramId } from '@volley/domain';
import type {
  GameMessageView,
  RenderedTelegramMessage,
} from './game-message.model.js';
import { renderGameMessage } from './game-message.renderer.js';

export class TelegramMessageNotEditableError extends Error {
  public constructor(message = 'Telegram message is not editable') {
    super(message);
    this.name = 'TelegramMessageNotEditableError';
  }
}

export interface GameMessageViewRepository {
  load(groupId: GroupId, gameId: GameId): Promise<GameMessageView | null>;
  setCanonicalMessageId(
    groupId: GroupId,
    gameId: GameId,
    messageId: bigint,
  ): Promise<void>;
  withLockedView?<T>(
    groupId: GroupId,
    gameId: GameId,
    callback: (repository: GameMessageViewRepository) => Promise<T>,
  ): Promise<T>;
}

export interface GameMessageTelegramGateway {
  editMessage(
    chatId: TelegramId,
    messageId: bigint,
    message: RenderedTelegramMessage,
  ): Promise<void>;
  sendMessage(
    chatId: TelegramId,
    message: RenderedTelegramMessage,
  ): Promise<{ messageId: bigint | string }>;
  pinMessage?(chatId: TelegramId, messageId: bigint): Promise<void>;
}

export class GameMessageUpdater {
  private readonly pending = new Map<string, Promise<void>>();

  public constructor(
    private readonly games: GameMessageViewRepository,
    private readonly telegram: GameMessageTelegramGateway,
  ) {}

  public refresh(groupId: GroupId, gameId: GameId): Promise<void> {
    const key = `${groupId}:${gameId}`;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.refreshNow(groupId, gameId))
      .finally(() => {
        if (this.pending.get(key) === next) this.pending.delete(key);
      });
    this.pending.set(key, next);
    return next;
  }

  private async refreshNow(groupId: GroupId, gameId: GameId): Promise<void> {
    if (this.games.withLockedView !== undefined) {
      await this.games.withLockedView(groupId, gameId, (repository) =>
        this.refreshLocked(repository, groupId, gameId),
      );
      return;
    }
    await this.refreshLocked(this.games, groupId, gameId);
  }

  private async refreshLocked(
    games: GameMessageViewRepository,
    groupId: GroupId,
    gameId: GameId,
  ): Promise<void> {
    const view = await games.load(groupId, gameId);
    if (view === null) return;
    const rendered = renderGameMessage(view);
    if (view.canonicalMessageId !== null) {
      try {
        await this.telegram.editMessage(
          view.telegramChatId,
          view.canonicalMessageId,
          rendered,
        );
        if (view.pinMessage) {
          await this.telegram.pinMessage?.(
            view.telegramChatId,
            view.canonicalMessageId,
          );
        }
        return;
      } catch (error) {
        if (!(error instanceof TelegramMessageNotEditableError)) throw error;
      }
    }

    const sent = await this.telegram.sendMessage(view.telegramChatId, rendered);
    const messageId = BigInt(sent.messageId);
    await games.setCanonicalMessageId(groupId, gameId, messageId);
    if (view.pinMessage) {
      await this.telegram.pinMessage?.(view.telegramChatId, messageId);
    }
  }
}
