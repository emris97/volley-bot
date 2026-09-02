import {
  asGameId,
  asGroupId,
  asUserId,
  type GameId,
  type GameState,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  attendanceSnapshots,
  games,
  groupMembers,
  users,
} from '../schema/index.js';

export interface ManagementContextRecord {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  gameState: GameState;
  dmAvailable: boolean;
  hasFinalizedAttendance: boolean;
}

export class ManagementRepository {
  public constructor(private readonly database: Database) {}

  public async resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<ManagementContextRecord | null> {
    const [game] = await this.database
      .select({ groupId: games.groupId, state: games.state })
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1);
    if (game === undefined) return null;
    const [actor] = await this.database
      .select({
        userId: users.id,
        dmAvailableAt: users.dmAvailableAt,
      })
      .from(users)
      .innerJoin(
        groupMembers,
        and(
          eq(groupMembers.userId, users.id),
          eq(groupMembers.groupId, game.groupId),
        ),
      )
      .where(eq(users.telegramUserId, BigInt(telegramUserId)))
      .limit(1);
    if (actor === undefined) return null;
    const [attendance] = await this.database
      .select({ revision: attendanceSnapshots.revision })
      .from(attendanceSnapshots)
      .where(
        and(
          eq(attendanceSnapshots.groupId, game.groupId),
          eq(attendanceSnapshots.gameId, gameId),
          eq(attendanceSnapshots.finalized, true),
        ),
      )
      .orderBy(desc(attendanceSnapshots.revision))
      .limit(1);
    return {
      groupId: asGroupId(game.groupId),
      gameId: asGameId(gameId),
      userId: asUserId(actor.userId),
      gameState: game.state,
      dmAvailable: actor.dmAvailableAt !== null,
      hasFinalizedAttendance: attendance !== undefined,
    };
  }

  public async markPrivateAvailable(telegramUserId: TelegramId): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: new Date(), updatedAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  }

  public async markPrivateUnavailable(
    telegramUserId: TelegramId,
  ): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: null, updatedAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  }
}
