import {
  asGroupId,
  asTelegramId,
  asUserId,
  type Group,
  type GroupId,
  type GroupMembership,
  type GroupRole,
  type OnboardingState,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { auditEvents, groupMembers, groups, users } from '../schema/index.js';

export interface UpsertGroupFromTelegramInput {
  telegramChatId: TelegramId;
  title: string;
}

export interface ConfigureGroupInput {
  groupId: GroupId;
  actorTelegramId: TelegramId;
  timeZone: string;
  memberPriorityEnabled: boolean;
  tentativePromptMinutesBefore: number;
  tentativeResponseMinutes: number;
  reminderMinutesBefore: number;
  currency: 'RUB';
  roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
  pinGameMessages: boolean;
}

export interface GroupOnboardingSnapshot {
  telegramChatId: TelegramId;
  onboardingState: OnboardingState;
  progress: Record<string, unknown>;
  settings: {
    timeZone: string;
    memberPriorityEnabled: boolean;
    tentativePromptMinutesBefore: number;
    tentativeResponseMinutes: number;
    reminderMinutesBefore: number;
    currency: 'RUB';
    roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
    pinGameMessages: boolean;
  };
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

  public async findById(groupId: GroupId): Promise<Group | null> {
    const [row] = await this.database
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    return row === undefined ? null : toGroup(row);
  }

  public async findUserIdByTelegramUserId(
    telegramUserId: TelegramId,
  ): Promise<UserId | null> {
    const [row] = await this.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, toDatabaseTelegramId(telegramUserId)))
      .limit(1);
    return row === undefined ? null : asUserId(row.id);
  }

  public async findMembershipByUserId(
    groupId: GroupId,
    userId: UserId,
  ): Promise<Pick<GroupMembership, 'role' | 'membershipStatus'> | null> {
    const [row] = await this.database
      .select({
        membershipStatus: groupMembers.membershipStatus,
        role: groupMembers.role,
      })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)),
      )
      .limit(1);
    return row ?? null;
  }

  public async findTimeZone(groupId: GroupId): Promise<string | null> {
    const [row] = await this.database
      .select({ timeZone: groups.timeZone })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    return row?.timeZone ?? null;
  }

  public async findTelegramIdentity(
    groupId: GroupId,
    userId: UserId,
  ): Promise<{
    telegramChatId: TelegramId;
    telegramUserId: TelegramId;
  } | null> {
    const [row] = await this.database
      .select({
        telegramChatId: groups.telegramChatId,
        telegramUserId: users.telegramUserId,
      })
      .from(groups)
      .innerJoin(users, eq(users.id, userId))
      .where(eq(groups.id, groupId))
      .limit(1);
    return row === undefined
      ? null
      : {
          telegramChatId: fromDatabaseTelegramId(row.telegramChatId),
          telegramUserId: fromDatabaseTelegramId(row.telegramUserId),
        };
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

  public async beginOnboarding(
    groupId: GroupId,
    actorTelegramId: TelegramId,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [actor] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.telegramUserId, toDatabaseTelegramId(actorTelegramId)))
        .limit(1);
      if (actor === undefined) throw new Error('Onboarding actor not found');

      await transaction
        .update(groups)
        .set({ onboardingState: 'CONFIGURING', updatedAt: new Date() })
        .where(eq(groups.id, groupId));
      await transaction.insert(auditEvents).values({
        groupId,
        actorUserId: actor.id,
        eventType: 'GROUP_ONBOARDING_STARTED',
        entityType: 'GROUP',
        entityId: groupId,
      });
    });
  }

  public async configure(input: ConfigureGroupInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [actor] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(
          eq(users.telegramUserId, toDatabaseTelegramId(input.actorTelegramId)),
        )
        .limit(1);
      if (actor === undefined) throw new Error('Configuration actor not found');

      await transaction
        .update(groups)
        .set({
          timeZone: input.timeZone,
          memberPriorityEnabled: input.memberPriorityEnabled,
          tentativePromptMinutesBefore: input.tentativePromptMinutesBefore,
          tentativeResponseMinutes: input.tentativeResponseMinutes,
          reminderMinutesBefore: input.reminderMinutesBefore,
          currency: input.currency,
          roundingMode: input.roundingMode,
          pinGameMessages: input.pinGameMessages,
          onboardingState: 'CONFIGURED',
          onboardingData: {},
          updatedAt: new Date(),
        })
        .where(eq(groups.id, input.groupId));
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: actor.id,
        eventType: 'GROUP_CONFIGURED',
        entityType: 'GROUP',
        entityId: input.groupId,
        payload: { timeZone: input.timeZone },
      });
    });
  }

  public async saveWizardProgress(
    groupId: GroupId,
    progress: Record<string, unknown>,
  ): Promise<void> {
    await this.database
      .update(groups)
      .set({ onboardingData: progress, updatedAt: new Date() })
      .where(eq(groups.id, groupId));
  }

  public async getWizardProgress(
    groupId: GroupId,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.database
      .select({ onboardingData: groups.onboardingData })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (row === undefined) throw new Error('Group not found');
    return row.onboardingData;
  }

  public async getOnboardingSnapshot(
    groupId: GroupId,
  ): Promise<GroupOnboardingSnapshot | null> {
    const [row] = await this.database
      .select({
        telegramChatId: groups.telegramChatId,
        onboardingState: groups.onboardingState,
        progress: groups.onboardingData,
        timeZone: groups.timeZone,
        memberPriorityEnabled: groups.memberPriorityEnabled,
        tentativePromptMinutesBefore: groups.tentativePromptMinutesBefore,
        tentativeResponseMinutes: groups.tentativeResponseMinutes,
        reminderMinutesBefore: groups.reminderMinutesBefore,
        currency: groups.currency,
        roundingMode: groups.roundingMode,
        pinGameMessages: groups.pinGameMessages,
      })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (row === undefined) return null;
    if (
      row.currency !== 'RUB' ||
      !['EXACT', 'UP_1', 'UP_10', 'UP_50'].includes(row.roundingMode)
    ) {
      throw new Error('Invalid stored group settings');
    }
    return {
      telegramChatId: fromDatabaseTelegramId(row.telegramChatId),
      onboardingState: row.onboardingState,
      progress: row.progress,
      settings: {
        timeZone: row.timeZone,
        memberPriorityEnabled: row.memberPriorityEnabled,
        tentativePromptMinutesBefore: row.tentativePromptMinutesBefore,
        tentativeResponseMinutes: row.tentativeResponseMinutes,
        reminderMinutesBefore: row.reminderMinutesBefore,
        currency: row.currency,
        roundingMode: row.roundingMode as GroupOnboardingSnapshot['settings']['roundingMode'],
        pinGameMessages: row.pinGameMessages,
      },
    };
  }

  public async recordRoleChange(input: {
    groupId: GroupId;
    actorTelegramId: TelegramId;
    targetTelegramId: TelegramId;
    role: 'ORGANIZER' | 'MEMBER';
  }): Promise<void> {
    const [actor] = await this.database
      .select({ id: users.id })
      .from(users)
      .where(
        eq(users.telegramUserId, toDatabaseTelegramId(input.actorTelegramId)),
      )
      .limit(1);
    if (actor === undefined) throw new Error('Role change actor not found');
    await this.database.insert(auditEvents).values({
      groupId: input.groupId,
      actorUserId: actor.id,
      eventType: 'GROUP_ROLE_CHANGED',
      entityType: 'GROUP',
      entityId: input.groupId,
      payload: { targetTelegramId: input.targetTelegramId, role: input.role },
    });
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
