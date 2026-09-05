import {
  asGroupId,
  asTelegramId,
  asUserId,
  type GroupId,
  type GroupRole,
  type MembershipStatus,
  type OnboardingState,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  groupMembers,
  groups,
  organizerPreferences,
  users,
} from '../schema/index.js';

export interface StoredOrganizerGroup {
  groupId: GroupId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
  enabled: boolean;
  onboardingState: OnboardingState;
  userId: UserId;
  role: GroupRole;
  status: MembershipStatus;
}

const toDatabaseTelegramId = (value: TelegramId): bigint => BigInt(value);
const fromDatabaseTelegramId = (value: bigint): TelegramId =>
  asTelegramId(value.toString());

export class OrganizerDirectoryRepository {
  public constructor(private readonly database: Database) {}

  public async listKnownGroups(
    telegramUserId: TelegramId,
  ): Promise<readonly StoredOrganizerGroup[]> {
    const rows = await this.database
      .select({
        groupId: groups.id,
        telegramChatId: groups.telegramChatId,
        title: groups.title,
        timeZone: groups.timeZone,
        enabled: groups.enabled,
        onboardingState: groups.onboardingState,
        userId: users.id,
        role: groupMembers.role,
        status: groupMembers.membershipStatus,
      })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(users.telegramUserId, toDatabaseTelegramId(telegramUserId)));

    return rows.map((row) => this.toStoredGroup(row));
  }

  public async findKnownGroup(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<StoredOrganizerGroup | null> {
    const [row] = await this.database
      .select({
        groupId: groups.id,
        telegramChatId: groups.telegramChatId,
        title: groups.title,
        timeZone: groups.timeZone,
        enabled: groups.enabled,
        onboardingState: groups.onboardingState,
        userId: users.id,
        role: groupMembers.role,
        status: groupMembers.membershipStatus,
      })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(
        and(
          eq(groups.id, groupId),
          eq(users.telegramUserId, toDatabaseTelegramId(telegramUserId)),
        ),
      )
      .limit(1);

    return row === undefined ? null : this.toStoredGroup(row);
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
        .values({ telegramUserId: toDatabaseTelegramId(input.telegramUserId) })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: { updatedAt: now },
        })
        .returning({ id: users.id });
      if (user === undefined) {
        throw new Error('User upsert returned no row');
      }

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

  public async selectedGroup(
    telegramUserId: TelegramId,
  ): Promise<GroupId | null> {
    const [row] = await this.database
      .select({ groupId: organizerPreferences.selectedGroupId })
      .from(organizerPreferences)
      .innerJoin(users, eq(users.id, organizerPreferences.userId))
      .innerJoin(
        groupMembers,
        and(
          eq(groupMembers.userId, users.id),
          eq(groupMembers.groupId, organizerPreferences.selectedGroupId),
        ),
      )
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(users.telegramUserId, toDatabaseTelegramId(telegramUserId)))
      .limit(1);

    return row?.groupId === null || row === undefined
      ? null
      : asGroupId(row.groupId);
  }

  public async saveSelectedGroup(
    telegramUserId: TelegramId,
    groupId: GroupId,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [membership] = await transaction
        .select({ userId: users.id })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(
          and(
            eq(groups.id, groupId),
            eq(users.telegramUserId, toDatabaseTelegramId(telegramUserId)),
          ),
        )
        .limit(1);
      if (membership === undefined) {
        throw new Error('Cannot select a group without membership');
      }

      await transaction
        .insert(organizerPreferences)
        .values({ userId: membership.userId, selectedGroupId: groupId })
        .onConflictDoUpdate({
          target: organizerPreferences.userId,
          set: { selectedGroupId: groupId, updatedAt: new Date() },
        });
    });
  }

  private toStoredGroup(row: {
    groupId: string;
    telegramChatId: bigint;
    title: string;
    timeZone: string;
    enabled: boolean;
    onboardingState: OnboardingState;
    userId: string;
    role: GroupRole;
    status: MembershipStatus;
  }): StoredOrganizerGroup {
    return {
      groupId: asGroupId(row.groupId),
      telegramChatId: fromDatabaseTelegramId(row.telegramChatId),
      title: row.title,
      timeZone: row.timeZone,
      enabled: row.enabled,
      onboardingState: row.onboardingState,
      userId: asUserId(row.userId),
      role: row.role,
      status: row.status,
    };
  }
}
