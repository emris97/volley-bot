import type { RegistrationKind, RegistrationState } from '@volley/domain';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { games } from './games.js';
import { groups } from './groups.js';
import { users } from './users.js';

export const registrations = pgTable(
  'registrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    guestDisplayName: text('guest_display_name'),
    inviterUserId: uuid('inviter_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    kind: text('kind').$type<RegistrationKind>().notNull(),
    membershipPriority: integer('membership_priority').notNull(),
    state: text('state').$type<RegistrationState>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    confirmedAt: timestamp('confirmed_at', {
      mode: 'date',
      withTimezone: true,
    }),
    cancelledAt: timestamp('cancelled_at', {
      mode: 'date',
      withTimezone: true,
    }),
    cancellationReason: text('cancellation_reason'),
    manualRank: integer('manual_rank'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('registrations_group_game_idx').on(table.groupId, table.gameId),
    uniqueIndex('registrations_idempotency_key_unique').on(
      table.idempotencyKey,
    ),
    uniqueIndex('registrations_active_user_game_unique')
      .on(table.gameId, table.userId)
      .where(
        sql`${table.userId} is not null and ${table.state} <> 'CANCELLED'`,
      ),
    check(
      'registrations_identity_check',
      sql`(${table.kind} = 'MEMBER' and ${table.userId} is not null and ${table.guestDisplayName} is null) or (${table.kind} = 'GUEST' and ${table.userId} is null and ${table.guestDisplayName} is not null and ${table.inviterUserId} is not null)`,
    ),
    check(
      'registrations_state_check',
      sql`${table.state} in ('TENTATIVE', 'ROSTERED', 'WAITLISTED', 'CANCELLED')`,
    ),
    check(
      'registrations_kind_check',
      sql`${table.kind} in ('MEMBER', 'GUEST')`,
    ),
    check(
      'registrations_confirmation_check',
      sql`(${table.state} = 'TENTATIVE' and ${table.confirmedAt} is null) or (${table.state} <> 'TENTATIVE')`,
    ),
  ],
);
