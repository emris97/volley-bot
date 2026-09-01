import type {
  GroupRole,
  MembershipStatus,
  OnboardingState,
} from '@volley/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'bigint' }).notNull(),
    title: text('title').notNull(),
    timeZone: text('time_zone').default('UTC').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    onboardingState: text('onboarding_state')
      .$type<OnboardingState>()
      .default('PENDING')
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('groups_telegram_chat_id_unique').on(table.telegramChatId),
    check(
      'groups_onboarding_state_check',
      sql`${table.onboardingState} in ('PENDING', 'CONFIGURING', 'CONFIGURED')`,
    ),
  ],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<GroupRole>().notNull(),
    membershipStatus: text('membership_status')
      .$type<MembershipStatus>()
      .default('ACTIVE')
      .notNull(),
    checkedAt: timestamp('checked_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.groupId, table.userId],
      name: 'group_members_pkey',
    }),
    index('group_members_user_id_idx').on(table.userId),
    check(
      'group_members_role_check',
      sql`${table.role} in ('OWNER', 'ADMIN', 'ORGANIZER', 'MEMBER')`,
    ),
    check(
      'group_members_membership_status_check',
      sql`${table.membershipStatus} in ('ACTIVE', 'LEFT', 'BANNED')`,
    ),
  ],
);
