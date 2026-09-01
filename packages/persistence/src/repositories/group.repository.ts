import {
  asGroupId,
  asTelegramId,
  asUserId,
  type Group,
  type GroupId,
  type GroupMembership,
  type GroupRole,
  type TelegramId,
} from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { groupMembers, groups, users } from '../schema/index.js';

export interface UpsertGroupFromTelegramInput {
  telegramChatId: TelegramId;
  title: string;
}

const toDatabaseTelegramId = (value: TelegramId): bigint => BigInt(value);
const fromDatabaseTelegramId = (value: bigint): TelegramId =>
  asTelegramId(value.toString());

const toGroup = (row: typeof groups.$inferSelect): Group => ({
  id: asGroupId(row.id),
  telegramChatId: fromDatabaseTelegramId(row.telegramChatId),
  title: row.title,
  timeZone: row.timeZone,
  enabled: row.enabled,
  onboardingState: row.onboardingState,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class GroupRepository {
  public constructor(private readonly database: Database) {}

  public async findByTelegramChatId(
    telegramChatId: TelegramId,
  ): Promise<Group | null> {
    const [row] = await this.database
      .select()
      .from(groups)
      .where(eq(groups.telegramChatId, toDatabaseTelegramId(telegramChatId)))
      .limit(1);

    return row === undefined ? null : toGroup(row);
  }

  public async upsertFromTelegram(
    input: UpsertGroupFromTelegramInput,
  ): Promise<Group> {
    const [row] = await this.database
      .insert(groups)
      .values({
        telegramChatId: toDatabaseTelegramId(input.telegramChatId),
        title: input.title,
      })
      .onConflictDoUpdate({
        target: groups.telegramChatId,
        set: {
          enabled: true,
          title: input.title,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (row === undefined) {
      throw new Error('Group upsert returned no row');
    }

    return toGroup(row);
  }

  public async setEnabled(groupId: GroupId, enabled: boolean): Promise<Group> {
    const [row] = await this.database
      .update(groups)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(groups.id, groupId))
      .returning();

    if (row === undefined) {
      throw new Error('Group not found');
    }

    return toGroup(row);
  }

  public async upsertMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
    role: GroupRole,
  ): Promise<GroupMembership> {
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const [user] = await transaction
        .insert(users)
        .values({ telegramUserId: toDatabaseTelegramId(telegramUserId) })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: { updatedAt: now },
        })
        .returning({ id: users.id });

      if (user === undefined) {
        throw new Error('User upsert returned no row');
      }

      const [membership] = await transaction
        .insert(groupMembers)
        .values({
          checkedAt: now,
          groupId,
          membershipStatus: 'ACTIVE',
          role,
          userId: user.id,
        })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: {
            checkedAt: now,
            membershipStatus: 'ACTIVE',
            role,
            updatedAt: now,
          },
        })
        .returning();

      if (membership === undefined) {
        throw new Error('Membership upsert returned no row');
      }

      return {
        groupId: asGroupId(membership.groupId),
        userId: asUserId(membership.userId),
        telegramUserId,
        role: membership.role,
        membershipStatus: membership.membershipStatus,
        checkedAt: membership.checkedAt,
      };
    });
  }

  public async findMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<GroupMembership | null> {
    const [row] = await this.database
      .select({
        checkedAt: groupMembers.checkedAt,
        groupId: groupMembers.groupId,
        membershipStatus: groupMembers.membershipStatus,
        role: groupMembers.role,
        telegramUserId: users.telegramUserId,
        userId: groupMembers.userId,
      })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(users.telegramUserId, toDatabaseTelegramId(telegramUserId)),
        ),
      )
      .limit(1);

    if (row === undefined) {
      return null;
    }

    return {
      groupId: asGroupId(row.groupId),
      userId: asUserId(row.userId),
      telegramUserId: fromDatabaseTelegramId(row.telegramUserId),
      role: row.role,
      membershipStatus: row.membershipStatus,
      checkedAt: row.checkedAt,
    };
  }
}
