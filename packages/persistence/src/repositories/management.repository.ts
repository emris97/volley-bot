import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asTelegramId,
  asUserId,
  type Game,
  type GameId,
  type GameState,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  attendanceSnapshots,
  games,
  groupMembers,
  groups,
  registrations,
  users,
} from '../schema/index.js';

export interface ManagementContextRecord {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  telegramChatId: TelegramId;
  game: Game;
  gameState: GameState;
  dmAvailable: boolean;
  registrationCount: number;
  rosterCount: number;
  waitlistCount: number;
  hasFinalizedAttendance: boolean;
  canonicalPinFailedAt: Date | null;
}

export class ManagementRepository {
  public constructor(private readonly database: Database) {}

  public async resolveGameGroup(gameId: GameId): Promise<{
    groupId: GroupId;
    telegramChatId: TelegramId;
  } | null> {
    const [row] = await this.database
      .select({
        groupId: games.groupId,
        telegramChatId: groups.telegramChatId,
      })
      .from(games)
      .innerJoin(groups, eq(groups.id, games.groupId))
      .where(eq(games.id, gameId))
      .limit(1);
    return row === undefined
      ? null
      : {
          groupId: asGroupId(row.groupId),
          telegramChatId: asTelegramId(row.telegramChatId.toString()),
        };
  }

  public async refreshMembership(input: {
    groupId: GroupId;
    telegramUserId: TelegramId;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    status: 'ACTIVE' | 'LEFT';
  }): Promise<UserId> {
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const [user] = await transaction
        .insert(users)
        .values({ telegramUserId: BigInt(input.telegramUserId) })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: { updatedAt: now },
        })
        .returning({ id: users.id });
      if (user === undefined) throw new Error('User upsert returned no row');
      await transaction
        .insert(groupMembers)
        .values({
          groupId: input.groupId,
          userId: user.id,
          role: input.role,
          membershipStatus: input.status,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: {
            role: input.role,
            membershipStatus: input.status,
            checkedAt: now,
            updatedAt: now,
          },
        });
      return asUserId(user.id);
    });
  }

  public async resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<ManagementContextRecord | null> {
    const [game] = await this.database
      .select({ game: games, telegramChatId: groups.telegramChatId })
      .from(games)
      .innerJoin(groups, eq(groups.id, games.groupId))
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
          eq(groupMembers.groupId, game.game.groupId),
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
          eq(attendanceSnapshots.groupId, game.game.groupId),
          eq(attendanceSnapshots.gameId, gameId),
          eq(attendanceSnapshots.finalized, true),
        ),
      )
      .orderBy(desc(attendanceSnapshots.revision))
      .limit(1);
    const [counts] = await this.database
      .select({
        registrationCount: sql<number>`count(*)::integer`,
        rosterCount: sql<number>`count(*) filter (where ${registrations.state} = 'ROSTERED')::integer`,
        waitlistCount: sql<number>`count(*) filter (where ${registrations.state} = 'WAITLISTED')::integer`,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.groupId, game.game.groupId),
          eq(registrations.gameId, gameId),
        ),
      );
    return {
      groupId: asGroupId(game.game.groupId),
      gameId: asGameId(gameId),
      userId: asUserId(actor.userId),
      telegramChatId: asTelegramId(game.telegramChatId.toString()),
      game: toGame(game.game),
      gameState: game.game.state,
      dmAvailable: actor.dmAvailableAt !== null,
      registrationCount: counts?.registrationCount ?? 0,
      rosterCount: counts?.rosterCount ?? 0,
      waitlistCount: counts?.waitlistCount ?? 0,
      hasFinalizedAttendance: attendance !== undefined,
      canonicalPinFailedAt: game.game.canonicalPinFailedAt,
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

const toGame = (row: typeof games.$inferSelect): Game => ({
  id: asGameId(row.id),
  groupId: asGroupId(row.groupId),
  sourceTemplateId:
    row.sourceTemplateId === null
      ? null
      : asGameTemplateId(row.sourceTemplateId),
  name: row.name,
  venue: row.venue,
  address: row.address,
  startsAt: row.startsAt,
  durationMinutes: row.durationMinutes,
  capacity: row.capacity,
  timeZone: row.timeZone,
  registrationOpensAt: row.registrationOpensAt,
  registrationClosesAt: row.registrationClosesAt,
  tentativePromptAt: row.tentativePromptAt,
  tentativeResponseDeadline: row.tentativeResponseDeadline,
  reminderAt: row.reminderAt,
  memberPriorityEnabled: row.memberPriorityEnabled,
  totalCostMinor: row.totalCostMinor,
  currency: 'RUB',
  roundingMode: row.roundingMode,
  state: row.state,
  revision: row.revision,
  scheduleRevision: row.scheduleRevision,
  canonicalTelegramMessageId: row.canonicalTelegramMessageId,
});
