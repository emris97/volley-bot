import {
  asGameId,
  asGroupId,
  asTelegramId,
  type GameId,
  type GameState,
  type GroupId,
  type TelegramId,
} from '@volley/domain';
import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type { Database } from '../client.js';
import * as schema from '../schema/index.js';
import { games, groups, registrations, users } from '../schema/index.js';

export interface StoredGameMessageView {
  groupId: GroupId;
  gameId: GameId;
  telegramChatId: TelegramId;
  canonicalMessageId: bigint | null;
  pinMessage: boolean;
  name: string;
  venue: string;
  address: string | null;
  startsAt: Date;
  timeZone: string;
  state: GameState;
  capacity: number;
  roster: readonly string[];
  waitlist: readonly string[];
  tentative: readonly string[];
}

export class GameMessageRepository {
  public constructor(
    private readonly database: Database,
    private readonly pool?: Pool,
  ) {}

  public async load(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<StoredGameMessageView | null> {
    return this.loadWith(this.database, groupId, gameId);
  }

  public async setCanonicalMessageId(
    groupId: GroupId,
    gameId: GameId,
    messageId: bigint,
  ): Promise<void> {
    await this.setCanonicalWith(this.database, groupId, gameId, messageId);
  }

  public async withLockedView<T>(
    groupId: GroupId,
    gameId: GameId,
    callback: (repository: {
      load(
        groupId: GroupId,
        gameId: GameId,
      ): Promise<StoredGameMessageView | null>;
      setCanonicalMessageId(
        groupId: GroupId,
        gameId: GameId,
        messageId: bigint,
      ): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    if (this.pool === undefined) {
      return callback({
        load: (lockedGroupId, lockedGameId) =>
          this.load(lockedGroupId, lockedGameId),
        setCanonicalMessageId: (lockedGroupId, lockedGameId, messageId) =>
          this.setCanonicalMessageId(lockedGroupId, lockedGameId, messageId),
      });
    }

    const client = await this.pool.connect();
    const lockedDatabase = drizzle(client, { schema }) as Database;
    const lockIdentity = `${groupId}:${gameId}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        lockIdentity,
      ]);
      return await callback({
        load: (lockedGroupId, lockedGameId) =>
          this.loadWith(lockedDatabase, lockedGroupId, lockedGameId),
        setCanonicalMessageId: (lockedGroupId, lockedGameId, messageId) =>
          this.setCanonicalWith(
            lockedDatabase,
            lockedGroupId,
            lockedGameId,
            messageId,
          ),
      });
    } finally {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [lockIdentity],
        );
      } finally {
        client.release();
      }
    }
  }

  private async loadWith(
    database: QueryDatabase,
    groupId: GroupId,
    gameId: GameId,
  ): Promise<StoredGameMessageView | null> {
    const [game] = await database
      .select({
        groupId: games.groupId,
        gameId: games.id,
        telegramChatId: groups.telegramChatId,
        canonicalMessageId: games.canonicalTelegramMessageId,
        pinMessage: groups.pinGameMessages,
        name: games.name,
        venue: games.venue,
        address: games.address,
        startsAt: games.startsAt,
        timeZone: games.timeZone,
        state: games.state,
        capacity: games.capacity,
      })
      .from(games)
      .innerJoin(groups, eq(groups.id, games.groupId))
      .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
      .limit(1);
    if (game === undefined) return null;

    const rows = await database
      .select({
        state: registrations.state,
        kind: registrations.kind,
        guestDisplayName: registrations.guestDisplayName,
        displayName: users.displayName,
        telegramUserId: users.telegramUserId,
        createdAt: registrations.createdAt,
      })
      .from(registrations)
      .leftJoin(users, eq(users.id, registrations.userId))
      .where(
        and(
          eq(registrations.groupId, groupId),
          eq(registrations.gameId, gameId),
          ne(registrations.state, 'CANCELLED'),
        ),
      );
    rows.sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    const namesFor = (state: typeof registrations.$inferSelect.state) =>
      rows
        .filter((row) => row.state === state)
        .map((row) =>
          row.kind === 'GUEST'
            ? row.guestDisplayName!
            : (row.displayName ??
              `Игрок ${row.telegramUserId?.toString() ?? ''}`),
        );

    return {
      ...game,
      groupId: asGroupId(game.groupId),
      gameId: asGameId(game.gameId),
      telegramChatId: asTelegramId(game.telegramChatId.toString()),
      roster: namesFor('ROSTERED'),
      waitlist: namesFor('WAITLISTED'),
      tentative: namesFor('TENTATIVE'),
    };
  }

  private async setCanonicalWith(
    database: QueryDatabase,
    groupId: GroupId,
    gameId: GameId,
    messageId: bigint,
  ): Promise<void> {
    await database
      .update(games)
      .set({ canonicalTelegramMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(games.groupId, groupId), eq(games.id, gameId)));
  }
}

type QueryDatabase = Database;
